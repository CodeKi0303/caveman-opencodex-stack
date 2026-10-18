import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Transform} from 'node:stream';

const DEFAULT_LIMIT = 268435456;
const hopHeaders = ['connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailer','transfer-encoding','upgrade','host'];
const requestDenied = new Set([...hopHeaders, 'x-caveman-gateway-key', 'x-caveman-compression', 'cookie',
  'forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
const responseDenied = new Set([...hopHeaders, 'x-caveman-gateway-key', 'authorization',
  'chatgpt-account-id','x-api-key','cookie','set-cookie','location']);
const routes = new Map([
  ['/v1/models', new Set(['GET'])],
  ['/v1/catalog', new Set(['GET','HEAD'])],
  ['/v1/responses', new Set(['POST'])],
  ['/v1/responses/compact', new Set(['POST'])],
  ['/v1/images/generations', new Set(['POST'])],
  ['/v1/images/edits', new Set(['POST'])],
  ['/v1/alpha/search', new Set(['POST'])],
]);

function canonicalUpstream(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid bridge upstream URL'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !['/v1','/v1/'].includes(url.pathname))
    throw Error('Bridge upstream must be an HTTP(S) /v1 URL without credentials, query, or fragment');
  url.pathname = '/v1';
  return url;
}

function cleanHeaders(headers, denied) {
  const blocked = new Set([...denied, ...(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith('access-control-')));
}

function isLoopback(address) {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
}

function validLocalRequest(req) {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const port = req.socket.localPort;
  const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!localHosts.has((req.headers.host ?? '').toLowerCase())) return false;
  // Native clients omit these headers. Browser callers must be on this exact
  // loopback service; accepting another localhost port enables drive-by use.
  if (req.headers.origin !== undefined) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return false; }
    if (origin.protocol !== 'http:' || origin.username || origin.password ||
        !localHosts.has(origin.host.toLowerCase()) || origin.pathname !== '/' || origin.search || origin.hash)
      return false;
  }
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'none' || site === 'same-origin';
}

/** A local-only, streaming adapter for Codex's built-in openai provider.
 * The provider supplies OAuth/account headers; this adapter adds the LAN key.
 * The destination is fixed at startup and never derived from incoming headers.
 */
export function createNativeBridge({upstreamUrl, key, maxRequestBytes = DEFAULT_LIMIT, timeoutMs = 300000, getSettings} = {}) {
  canonicalUpstream(upstreamUrl);
  if (typeof key !== 'string' || key.length < 32 || /[\r\n]/.test(key))
    throw Error('Bridge gateway key must be at least 32 characters without line breaks');
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > DEFAULT_LIMIT)
    throw Error('Invalid bridge request limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
    throw Error('Invalid bridge upstream timeout');
  const sendError = (res, status, message) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.shouldKeepAlive = false;
    res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'})
      .end(JSON.stringify({error:{message}}));
  };
  const server = http.createServer((req, res) => {
    if (!validLocalRequest(req)) return sendError(res,403,'Only same-origin loopback clients are allowed');
    let destination, activeKey, compression;
    try {
      const settings = getSettings?.() ?? {upstreamUrl,key};
      destination = canonicalUpstream(settings.upstreamUrl);
      activeKey = settings.key;
      if (typeof activeKey !== 'string' || activeKey.length < 32 || /[\r\n]/.test(activeKey)) throw Error();
      compression = settings.compression !== false;
    } catch { return sendError(res,503,'Bridge settings are unavailable'); }
    const request = destination.protocol === 'https:' ? https.request : http.request;
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'})
        .end(JSON.stringify({service:'caveman-native-bridge',status:'ok',ok:true,
          upstream:destination.href,upstreamUrl:destination.href,pid:process.pid,max_request_bytes:maxRequestBytes,
          compression,controlVersion:1}));
      return;
    }
    const [pathname] = (req.url ?? '').split('?');
    const methods = routes.get(pathname);
    // Preserve only the models query used by Codex catalog version negotiation.
    if (!methods || (pathname !== '/v1/models' && req.url !== pathname))
      return sendError(res,404,'Unsupported bridge route');
    if (!methods.has(req.method)) return sendError(res,405,'Unsupported bridge method');
    const length = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
    if (length !== null && (!Number.isSafeInteger(length) || length < 0))
      return sendError(res,400,'Invalid Content-Length');
    if (length !== null && length > maxRequestBytes)
      return sendError(res,413,'Request body exceeds bridge limit');

    let rejected = false;
    let responseStream;
    const upstream = request({protocol:destination.protocol, hostname:destination.hostname,
      port:destination.port || undefined, method:req.method, path:req.url,
      headers:{...cleanHeaders(req.headers,requestDenied),'x-caveman-gateway-key':activeKey,
        'x-caveman-compression':compression?'on':'off'}}, response => {
      responseStream = response;
      if (rejected || res.destroyed || res.writableEnded) { response.destroy(); return; }
      const status = response.statusCode ?? 502;
      // Never allow the client to replay OAuth or the LAN key to a redirect target.
      // 304 is the catalog's conditional-read response, not a redirect.
      if (status >= 300 && status < 400 && status !== 304) {
        rejected = true;
        response.destroy();
        sendError(res,502,'Gateway redirects are not allowed');
        return;
      }
      res.writeHead(status, cleanHeaders(response.headers,responseDenied));
      res.flushHeaders();
      response.on('error', () => res.destroy());
      response.on('aborted', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Gateway timeout')));
    upstream.on('error', () => { if (!rejected) sendError(res,502,'Gateway connection failed'); });
    let receivedBytes = 0;
    const limiter = new Transform({transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxRequestBytes) {
        rejected = true;
        sendError(res,413,'Request body exceeds bridge limit');
        callback(new Error('Bridge request limit exceeded'));
      } else callback(null,chunk);
    }});
    const stop = () => {
      req.unpipe(limiter);
      limiter.destroy();
      upstream.destroy();
      responseStream?.destroy();
    };
    limiter.on('error', stop);
    req.on('aborted', stop);
    req.on('error', stop);
    res.on('close', stop);
    req.pipe(limiter).pipe(upstream);
  });
  server.on('connection', socket => {
    socket.on('error', () => socket.destroy());
    if (!isLoopback(socket.remoteAddress)) socket.destroy();
  });
  // Built-in openai may try WebSocket Responses. An explicit refusal lets the
  // client use its existing HTTP/SSE fallback without an unauthenticated tunnel.
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.headersTimeout = 20000;
  server.requestTimeout = 120000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config' || !isAbsolute(process.argv[3]))
      throw Error('Usage: node native-bridge.mjs --config <absolute JSON config path>');
    const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    if (typeof config.keyFile !== 'string' || !isAbsolute(config.keyFile))
      throw Error('Bridge keyFile must be an absolute path');
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
      throw Error('Bridge port must be between 1024 and 65535');
    const getSettings = () => {
      const current=JSON.parse(readFileSync(process.argv[3],'utf8'));
      return {...current,key:readFileSync(current.keyFile,'utf8').trim()};
    };
    const server = createNativeBridge({...config,key:readFileSync(config.keyFile,'utf8').trim(),getSettings});
    server.on('error', () => { console.error('Native bridge could not listen on its loopback port'); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => console.log(`Native bridge listening on 127.0.0.1:${config.port}`));
    const stop = () => {
      server.close();
      setTimeout(() => server.closeAllConnections(),10000).unref();
    };
    process.on('SIGTERM',stop);
    process.on('SIGINT',stop);
  } catch {
    // Config/key parsing errors can contain private values. Keep startup logs generic.
    console.error('Native bridge startup failed; check the JSON config, key file, and loopback port');
    process.exitCode = 1;
  }
}
