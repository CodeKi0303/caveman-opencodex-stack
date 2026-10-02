import http from 'node:http';
import https from 'node:https';
import {BlockList} from 'node:net';
import {timingSafeEqual, createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Transform} from 'node:stream';

// Match OpenCodex's bounded raw/decoded JSON ingress limit. The startup script
// reads this same file for Caveman, whose built-in default is only 32 MiB.
export const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES || 268435456);
function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 268435456) throw Error('Invalid request limit');
}
const deniedHeaders = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailer','transfer-encoding','upgrade','host','x-caveman-gateway-key',
  'forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
export function addressPolicy(cidrs = '') {
  if (!cidrs.trim()) return () => true;
  const list = new BlockList();
  for (const part of cidrs.split(',')) {
    const [ip, prefix] = part.trim().split('/');
    const type = ip.includes(':') ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(ip,type);
    else list.addSubnet(ip,Number(prefix),type);
  }
  return address => {
    const ip = (address || '').replace(/^::ffff:/,'');
    return list.check(ip, ip.includes(':') ? 'ipv6' : 'ipv4');
  };
}
export function cleanHeaders(headers) {
  const denied = new Set([...deniedHeaders, ...(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !denied.has(name.toLowerCase())));
}
export function requestMetadata(req) {
  // Never log raw URLs, queries, header values, prompts, or image payloads.
  const pathname = (req.url ?? '').split('?')[0];
  const path = pathname.split('/').map(part => /^(?:[a-z_-]{1,40}|v[0-9]+)$/.test(part) || part === '' ? part : ':redacted').join('/').slice(0,240);
  const media = (req.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  return {time:new Date().toISOString(),method:req.method,path,query_present:(req.url ?? '').includes('?'),
    content_type:['application/json','multipart/form-data','application/octet-stream'].includes(media)?media:'other',
    authorization_present:typeof req.headers.authorization === 'string',
    account_id_present:typeof req.headers['chatgpt-account-id'] === 'string',
    gateway_key_present:typeof req.headers['x-caveman-gateway-key'] === 'string'};
}
export function createGateway({key, request = http.request, audit = () => {}, maxRequestBytes = MAX_REQUEST_BYTES, allowedAddress = addressPolicy(), tls, catalogPath, recoveryMcp} = {}) {
  validateLimit(maxRequestBytes);
  if (typeof key !== 'string' || key.length < 32) throw Error('Gateway key must be at least 32 characters');
  let recovery = recoveryMcp;
  let recoveryLoading;
  let recoveryClosed = false;
  const loadRecovery = () => recovery ? Promise.resolve(recovery) : recoveryLoading ??= import('./recovery-mcp.mjs')
    .then(({createRecoveryMcp}) => { recovery = createRecoveryMcp(); return recovery; })
    .finally(() => { recoveryLoading = undefined; });
  const sendError = (res, status, message, details = {}) => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) res.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify({error:{message,...details}}));
    else res.destroy();
  };
  const handler = (req, res) => {
    if (!allowedAddress(req.socket.remoteAddress)) return sendError(res,403,'Client network not allowed');
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({
        service:'caveman-lan-gateway',status:'ok',max_request_bytes:maxRequestBytes})); return;
    }
    const supplied = req.headers['x-caveman-gateway-key'];
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(key) ||
        !timingSafeEqual(Buffer.from(supplied),Buffer.from(key))) return sendError(res,401,'Gateway key required');
    if (req.url === '/mcp') {
      if (recoveryClosed) return sendError(res,503,'Recovery is shutting down');
      void loadRecovery().then(async bridge => {
        if (recoveryClosed) { await bridge.close(); return sendError(res,503,'Recovery is shutting down'); }
        await bridge.handle(req,res);
      }).catch(() => sendError(res,503,'Recovery backend unavailable'));
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/v1/catalog') {
      try {
        const data = readFileSync(catalogPath);
        const etag = '"' + createHash('sha256').update(data).digest('hex') + '"';
        const headers = {'content-type':'application/json', 'cache-control':'private, no-cache',
          etag, vary:'x-caveman-gateway-key'};
        const matches = (req.headers['if-none-match'] ?? '').split(',')
          .some(value => value.trim() === '*' || value.trim().replace(/^W\//,'') === etag);
        if (matches) res.writeHead(304,headers).end();
        else res.writeHead(200,{...headers,'content-length':data.length}).end(req.method === 'HEAD' ? undefined : data);
      } catch { sendError(res,503,'Run stack catalog first'); }
      return;
    }
    const metadata = requestMetadata(req);
    const lengthHeader = req.headers['content-length'];
    const length = lengthHeader === undefined ? null : Number(lengthHeader);
    metadata.declared_body_bytes = Number.isSafeInteger(length) && length >= 0 ? length : null;
    metadata.received_body_bytes = 0;
    metadata.request_limit_bytes = maxRequestBytes;
    res.on('finish', () => { try { audit({...metadata,status:res.statusCode}); } catch {} });
    const tooLarge = stage => {
      metadata.rejected_by = 'gateway';
      metadata.rejection_stage = stage;
      // Stop accepting a rejected upload after delivering the error response.
      res.shouldKeepAlive = false;
      sendError(res,413,`Request too large (gateway limit: ${maxRequestBytes} bytes)`,
        {code:'gateway_request_too_large',limit_bytes:maxRequestBytes});
    };
    let port, upstreamPath;
    const pathname = (req.url ?? '').split('?')[0];
    const imageRoute = req.method === 'POST' &&
      (pathname === '/v1/images/generations' || pathname === '/v1/images/edits');
    const sidecarRoute = req.method === 'POST' &&
      (pathname === '/v1/alpha/search' || pathname === '/v1/responses/compact');
    if (req.method === 'POST' && req.url === '/v1/responses') {
      port = 8787; upstreamPath = '/compat/opencodex/v1/responses';
    } else if (req.method === 'GET' && pathname === '/v1/models') {
      // Caveman compat has no catalog route. Metadata is read directly from OpenCodex.
      port = 10101; upstreamPath = req.url;
    } else if (imageRoute || sidecarRoute) {
      // Native ImageGen uses JSON, including edits with embedded reference images.
      // Search and compact also need their original request representation.
      // Bypass text compression for these explicitly supported OpenCodex routes.
      port = 10101; upstreamPath = pathname;
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json')
        return sendError(res,415,'This OpenCodex tool route requires application/json');
    } else return sendError(res,404,'Unsupported gateway route');
    metadata.upstream = imageRoute ? 'opencodex-images' : sidecarRoute
      ? pathname === '/v1/alpha/search' ? 'opencodex-search' : 'opencodex-compact'
      : port === 8787 ? 'caveman-responses' : 'opencodex-models';
    const encoding = (req.headers['content-encoding'] ?? 'identity').toLowerCase();
    const encodings = imageRoute || sidecarRoute ? ['identity','gzip','deflate','zstd'] : ['identity'];
    if (!encodings.includes(encoding))
      return sendError(res,415,'Disable Codex request body compression for this provider');
    if (length !== null && (!Number.isSafeInteger(length) || length < 0))
      return sendError(res,400,'Invalid Content-Length');
    if (length !== null && length > maxRequestBytes) return tooLarge('content-length');
    let rejected = false;
    const upstream = request({hostname:'127.0.0.1',port,path:upstreamPath,method:req.method,
      headers:cleanHeaders(req.headers)}, response => {
      if (rejected || res.destroyed || res.writableEnded) { response.destroy(); return; }
      metadata.upstream_status = response.statusCode ?? 502;
      res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.setTimeout(300000, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () => { if (!rejected) sendError(res,502,'Upstream connection failed'); });
    // A Transform preserves stream backpressure and never forwards the chunk
    // that crosses the cap. Counting beside req.pipe() can forward it anyway.
    const limiter = new Transform({transform(chunk, _encoding, callback) {
      metadata.received_body_bytes += chunk.length;
      if (metadata.received_body_bytes > maxRequestBytes) {
        rejected = true;
        tooLarge('stream');
        callback(new Error('Request body limit exceeded'));
      } else callback(null,chunk);
    }});
    limiter.on('error', () => {
      req.unpipe(limiter);
      upstream.destroy();
    });
    const stopUpload = () => { req.unpipe(limiter); limiter.destroy(); upstream.destroy(); };
    req.on('aborted', stopUpload);
    req.on('error', stopUpload);
    res.on('close', stopUpload);
    req.pipe(limiter).pipe(upstream);
  };
  const server = tls ? https.createServer(tls,handler) : http.createServer(handler);
  server.closeRecovery = async () => {
    recoveryClosed = true;
    const bridge = recovery ?? await recoveryLoading?.catch(() => undefined);
    await bridge?.close();
  };
  server.once('close', () => { void server.closeRecovery(); });
  // An upgraded socket leaves Node's HTTP request lifecycle. A peer resetting
  // that socket must not become an unhandled error that kills every LAN route.
  server.on('connection', socket => socket.on('error', () => socket.destroy()));
  server.on('upgrade', (_req,socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.headersTimeout = 20000;
  server.requestTimeout = 120000;
  server.on('clientError', (_err,socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tls = process.env.GATEWAY_TLS_CERT && process.env.GATEWAY_TLS_KEY ? {
    cert:readFileSync(process.env.GATEWAY_TLS_CERT),key:readFileSync(process.env.GATEWAY_TLS_KEY)
  } : undefined;
  if (Boolean(process.env.GATEWAY_TLS_CERT) !== Boolean(process.env.GATEWAY_TLS_KEY)) throw Error('TLS needs both certificate and key');
  const server = createGateway({
    key:readFileSync('/run/secrets/gateway-key','utf8').trim(),
    allowedAddress:addressPolicy(process.env.ALLOWED_CIDRS || ''),tls,
    catalogPath:'/state/catalog/models.json',
    audit:record=>console.log(JSON.stringify(record))
  });
  server.listen(8080,'0.0.0.0');
  process.on('SIGTERM',()=>{
    void server.closeRecovery();
    server.close(); setTimeout(()=>server.closeAllConnections(),10000).unref();
  });
}
