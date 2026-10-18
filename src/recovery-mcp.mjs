import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError} from '@modelcontextprotocol/sdk/types.js';
import {readFileSync} from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const TOOL = {
  name: 'caveman_retrieve',
  description: 'Recover content compressed by this server. Pass its exact recovery_handle (ccr_…, <<ccr:…>>, or ccr://…). Omit query for the complete original; use query for relevant complete records. Unknown handles return an error.',
  inputSchema: {type: 'object', properties: {
    recovery_handle: {type: 'string', minLength: 1, maxLength: 1024},
    query: {type: 'string', maxLength: 32768}
  }, required: ['recovery_handle'], additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}
};

function toolError(code, message) {
  return {isError: true, content: [{type: 'text', text: `${code}: ${message}`}]};
}

function validatedArguments(params) {
  const args = params.arguments;
  if (params.name !== TOOL.name) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.recovery_handle !== 'string' || !args.recovery_handle.trim()
      || args.recovery_handle.length > 1024
      || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 32768))
      || Object.keys(args).some(key => key !== 'recovery_handle' && key !== 'query')) {
    throw new McpError(ErrorCode.InvalidParams, 'Expected recovery_handle and optional query strings');
  }
  // Only this tool's arguments cross the stdio boundary, never HTTP headers or metadata.
  return {recovery_handle: args.recovery_handle, ...(args.query !== undefined ? {query: args.query} : {})};
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      error ? reject(error) : resolve(value);
    };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > limit) return finish({status: 413, message: 'MCP request too large'});
      chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish({status: 400, message: 'Invalid JSON'}); }
    };
    const failed = () => finish({status: 400, message: 'Incomplete request'});
    const aborted = () => failed();
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
  });
}

function httpError(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.shouldKeepAlive = false;
  res.writeHead(status, {'content-type': 'application/json', ...(status === 405 ? {allow: 'POST'} : {})});
  res.end(JSON.stringify({jsonrpc: '2.0', error: {code: -32000, message}, id: null}));
}

/** Auth is owned by gateway.mjs. This private bridge exposes recovery, not arbitrary MCP calls. */
export function createRecoveryMcp({
  command = '/opt/caveman/bin/caveman-mcp', args = [],
  env = {CAVEMAN_HOME: process.env.CAVEMAN_HOME || '/state/caveman',
    CAVEMAN_CCR_DB: process.env.CAVEMAN_CCR_DB || '/state/caveman/ccr.db',
    // The SDK inherits only its safe environment allowlist, not the container's Caveman flags.
    CAVEMAN_OFFLINE: '1', CAVEMAN_TELEMETRY: '0'},
  timeoutMs = 30000, maxPending = 16, maxRequestBytes = 65536,
  // A maximum-size gateway payload can expand to six JSON bytes per control byte.
  maxBufferSize = 6 * 268435456 + 65536
} = {}) {
  for (const value of [timeoutMs, maxPending, maxRequestBytes, maxBufferSize]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid recovery limit');
  }
  let backend;
  let connecting;
  let opening;
  let pending = 0;
  let closed = false;
  const frontends = new Map();
  const discard = async client => {
    if (backend === client) backend = undefined;
    await client?.close().catch(() => {});
  };
  const connect = async () => {
    if (closed) throw new Error('Recovery bridge closed');
    if (backend) return backend;
    if (!opening) opening = (async () => {
      const client = new Client({name: 'caveman-stack-recovery', version: VERSION});
      connecting = client;
      const transport = new StdioClientTransport({command, args, env, stderr: 'pipe', maxBufferSize});
      // Upstream diagnostics may contain local paths; do not copy them to HTTP or gateway logs.
      transport.stderr?.resume();
      client.onclose = () => { if (backend === client) backend = undefined; };
      client.onerror = () => {};
      try {
        await client.connect(transport, {timeout: timeoutMs});
        if (closed) throw new Error('Recovery bridge closed');
        backend = client;
        return client;
      } catch (error) { await discard(client); throw error; }
      finally { if (connecting === client) connecting = undefined; }
    })().finally(() => { opening = undefined; });
    return opening;
  };
  const retrieve = async (arguments_, signal) => {
    if (closed) return toolError('cave_recovery_unavailable', 'Recovery is shutting down');
    if (pending >= maxPending) return toolError('cave_recovery_busy', 'Too many recovery calls; retry shortly');
    pending++;
    let client;
    try {
      client = await connect();
      // The SDK assigns distinct stdio IDs, even when separate HTTP clients reuse their IDs.
      return await client.callTool({name: TOOL.name, arguments: arguments_}, undefined, {timeout: timeoutMs, signal});
    } catch {
      // A disconnected client must not terminate concurrent callers' healthy shared backend.
      if (!signal?.aborted) await discard(client);
      return toolError('cave_recovery_unavailable', 'Recovery backend unavailable; retry shortly');
    } finally { pending--; }
  };

  return {
    async handle(req, res) {
      if (closed) return httpError(res, 503, 'Recovery is shutting down');
      if (req.method !== 'POST') return httpError(res, 405, 'Use MCP Streamable HTTP POST');
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error();
        } catch { return httpError(res, 403, 'Origin not allowed'); }
      }
      if ((req.headers['content-encoding'] ?? 'identity') !== 'identity') return httpError(res, 415, 'MCP requires an uncompressed JSON body');
      const length = req.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxRequestBytes)) {
        return httpError(res, 413, 'MCP request too large');
      }
      // The model bearer and gateway key terminate here; the MCP backend receives no HTTP auth.
      delete req.headers.authorization;
      delete req.headers['chatgpt-account-id'];
      delete req.headers['x-caveman-gateway-key'];
      let server;
      let cleanup;
      try {
        const body = await readJson(req, maxRequestBytes);
        server = new Server({name: 'caveman-stack-recovery', version: VERSION}, {capabilities: {tools: {}}});
        server.setRequestHandler(ListToolsRequestSchema, () => ({tools: [TOOL]}));
        server.setRequestHandler(CallToolRequestSchema, (request, extra) => retrieve(validatedArguments(request.params), extra.signal));
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        frontends.set(server, res);
        cleanup = () => { frontends.delete(server); void server.close().catch(() => {}); };
        res.once('close', cleanup);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        cleanup?.();
        httpError(res, error?.status ?? 500, error?.status ? error.message : 'MCP request failed');
      }
    },
    async close() {
      closed = true;
      const sessions = [...frontends];
      // JSON-mode transports have no SSE stream to close. Settle their HTTP response explicitly.
      for (const [, res] of sessions) httpError(res, 503, 'Recovery is shutting down');
      await Promise.allSettled(sessions.map(([server]) => server.close()));
      frontends.clear();
      const client = backend;
      backend = undefined;
      await Promise.allSettled([discard(client), discard(connecting)]);
      await opening?.catch(() => {});
    }
  };
}
