import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {createNativeBridge} from '../src/native-bridge.mjs';

const key = 'bridge-fixture-'.repeat(4);
test('bridge reloads destination policy per request and overrides caller compression preference',async t=>{
  const seen=[];const backend=http.createServer((q,s)=>{seen.push(q.headers);q.resume();s.end('ok');});backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const upstreamUrl=`http://127.0.0.1:${backend.address().port}/v1`;let settings={upstreamUrl,key,compression:false};
  const bridge=createNativeBridge({upstreamUrl,key,getSettings:()=>settings});bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
  t.after(()=>{bridge.closeAllConnections();bridge.close();backend.closeAllConnections();backend.close();});
  const url=`http://127.0.0.1:${bridge.address().port}`;
  await call(url+'/v1/responses',{method:'POST',body:'{}',headers:{'x-caveman-compression':'on'}});
  assert.equal(seen[0]['x-caveman-compression'],'off');
  settings={...settings,key:'changed-fixture-'.repeat(4),compression:true};
  await call(url+'/v1/responses',{method:'POST',body:'{}'});
  assert.equal(seen[1]['x-caveman-compression'],'on');assert.equal(seen[1]['x-caveman-gateway-key'],settings.key);
  settings={...settings,upstreamUrl:'file:///etc/passwd'};assert.equal((await call(url+'/v1/responses',{method:'POST',body:'{}'})).status,503);
});
async function fixture(t, {handler, maxRequestBytes = 1024, timeoutMs = 1000} = {}) {
  const seen = [];
  const backend = http.createServer((req, res) => {
    const record = {url:req.url,method:req.method,headers:req.headers,body:''};
    seen.push(record);
    req.on('data', chunk => record.body += chunk.toString());
    if (handler) handler(req,res,record);
    else req.on('end', () => res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}'));
  });
  backend.listen(0,'127.0.0.1');
  await once(backend,'listening');
  const upstreamUrl = `http://127.0.0.1:${backend.address().port}/v1`;
  const bridge = createNativeBridge({upstreamUrl,key,maxRequestBytes,timeoutMs});
  bridge.listen(0,'127.0.0.1');
  await once(bridge,'listening');
  t.after(() => {
    bridge.closeAllConnections(); bridge.close();
    backend.closeAllConnections(); backend.close();
  });
  return {url:`http://127.0.0.1:${bridge.address().port}`,port:bridge.address().port,
    upstreamUrl,seen,backend,bridge};
}

async function call(url, {method = 'GET',headers = {},body,chunked = false} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request(url,{method,headers},res => {
      let data = '';
      res.on('data',chunk => data += chunk);
      res.on('end',() => resolve({status:res.statusCode,headers:res.headers,body:data}));
      res.on('error',reject);
    });
    req.on('error',reject);
    if (body && chunked) { req.write(body.slice(0,10)); req.end(body.slice(10)); }
    else req.end(body);
  });
}

test('native bridge injects fixed key and preserves OAuth/account attribution',async t => {
  const f = await fixture(t);
  const result = await call(f.url+'/v1/responses',{method:'POST',body:'{"input":"fixture"}',headers:{
    authorization:'Bearer oauth-fixture','chatgpt-account-id':'account-fixture',
    'x-codex-turn-metadata':'{"fixture":true}','x-caveman-gateway-key':'caller-key',
    'content-type':'application/json',cookie:'private-cookie','x-forwarded-host':'other-host',
    connection:'keep-alive, x-private-hop','x-private-hop':'private-hop',
  }});
  assert.equal(result.status,200);
  assert.equal(f.seen.length,1);
  assert.equal(f.seen[0].headers['x-caveman-gateway-key'],key);
  assert.equal(f.seen[0].headers.authorization,'Bearer oauth-fixture');
  assert.equal(f.seen[0].headers['chatgpt-account-id'],'account-fixture');
  assert.equal(f.seen[0].headers['x-codex-turn-metadata'],'{"fixture":true}');
  assert.equal(f.seen[0].headers.cookie,undefined);
  assert.equal(f.seen[0].headers['x-forwarded-host'],undefined);
  assert.equal(f.seen[0].headers['x-private-hop'],undefined);
  assert.equal(f.seen[0].body,'{"input":"fixture"}');
});

test('all gateway model, tool and catalog routes use the fixed upstream',async t => {
  const f = await fixture(t);
  for (const route of ['responses','responses/compact','images/generations','images/edits','alpha/search'])
    assert.equal((await call(f.url+'/v1/'+route,{method:'POST',body:'{}'})).status,200);
  assert.equal((await call(f.url+'/v1/models?client_version=fixture')).status,200);
  assert.equal((await call(f.url+'/v1/catalog')).status,200);
  assert.equal((await call(f.url+'/v1/catalog',{method:'HEAD'})).status,200);
  assert.equal(f.seen[5].url,'/v1/models?client_version=fixture');
  assert(f.seen.every(row => row.headers['x-caveman-gateway-key'] === key));
  const health = await call(f.url+'/healthz');
  assert.deepEqual(JSON.parse(health.body),{service:'caveman-native-bridge',status:'ok',ok:true,
    upstream:f.upstreamUrl,upstreamUrl:f.upstreamUrl,pid:process.pid,max_request_bytes:1024,compression:true,controlVersion:1});
  assert.equal(f.seen.length,8);
});

test('headers received from upstream cannot disclose credentials or enable CORS',async t => {
  const f = await fixture(t,{handler:(_req,res) => res.writeHead(200,{
    'x-caveman-gateway-key':key,authorization:'Bearer upstream-fixture',
    'chatgpt-account-id':'account-fixture','x-api-key':'upstream-api-key',
    'set-cookie':'session=fixture','access-control-allow-origin':'*',
    connection:'keep-alive, x-private-hop','x-private-hop':'private',
    'content-type':'application/json','x-request-id':'request-fixture',
  }).end('{}')});
  const result = await call(f.url+'/v1/models');
  for (const name of ['x-caveman-gateway-key','authorization','chatgpt-account-id','x-api-key',
    'set-cookie','access-control-allow-origin','x-private-hop']) assert.equal(result.headers[name],undefined,name);
  assert.equal(result.headers['x-request-id'],'request-fixture');
  assert.equal(result.body,'{}');
});

test('browser cross-origin, rebound Host, unsupported routes and methods are rejected',async t => {
  const f = await fixture(t);
  for (const headers of [{host:'evil.example'}, {host:'127.0.0.1:1'},
    {origin:'https://evil.example'},{origin:'null'},{origin:'http://localhost:1'},
    {origin:`http://username@localhost:${f.port}`},{'sec-fetch-site':'cross-site'}])
    assert.equal((await call(f.url+'/v1/models',{headers})).status,403);
  assert.equal((await call(f.url+'/v1/models',{headers:{host:`localhost:${f.port}`,origin:`http://localhost:${f.port}`}})).status,200);
  for (const route of ['/v1/arbitrary','/v1/%2e%2e/models','/v1/responses?redirect=http://evil.example','/mcp'])
    assert.equal((await call(f.url+route)).status,404);
  assert.equal((await call(f.url+'/v1/models',{method:'POST'})).status,405);
  assert.equal((await call(f.url+'/v1/responses',{method:'OPTIONS'})).status,405);
  assert.equal(f.seen.length,1);
});

test('redirect responses are blocked while catalog 304 remains usable',async t => {
  let upstreamCalls = 0;
  const f = await fixture(t,{handler:(req,res) => {
    upstreamCalls++;
    if (req.url === '/v1/catalog') res.writeHead(304,{etag:'"fixture"'}).end();
    else res.writeHead(307,{location:'http://127.0.0.1:1/stolen','x-caveman-gateway-key':key}).end();
  }});
  const response = await call(f.url+'/v1/responses',{method:'POST',body:'{}'});
  assert.equal(response.status,502);
  assert.equal(response.headers.location,undefined);
  assert.equal(response.headers['x-caveman-gateway-key'],undefined);
  assert.equal(upstreamCalls,1);
  const catalog = await call(f.url+'/v1/catalog');
  assert.equal(catalog.status,304);
  assert.equal(catalog.headers.etag,'"fixture"');
});

test('SSE reaches the caller before the upstream finishes',async t => {
  let finishStream;
  const f = await fixture(t,{timeoutMs:10000,handler:(_req,res) => {
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: first\n\n');
    finishStream = () => res.end('data: last\n\n');
  }});
  const response = await fetch(f.url+'/v1/responses',{method:'POST',body:'{}'});
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value),'data: first\n\n');
  finishStream();
  const last = await reader.read();
  assert.equal(new TextDecoder().decode(last.value),'data: last\n\n');
  assert.equal((await reader.read()).done,true);
});

test('declared and streaming request bodies are bounded',async t => {
  const f = await fixture(t,{maxRequestBytes:16});
  const declared = await call(f.url+'/v1/responses',{method:'POST',body:'x'.repeat(17),headers:{'content-length':'17'}});
  assert.equal(declared.status,413);
  assert.equal(f.seen.length,0);
  const streamed = await call(f.url+'/v1/responses',{method:'POST',body:'x'.repeat(20),chunked:true});
  assert.equal(streamed.status,413);
  assert(f.seen.every(row => Buffer.byteLength(row.body) <= 16));
});

test('client SSE disconnect closes the upstream response',async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => upstreamClosed = resolve);
  const f = await fixture(t,{timeoutMs:10000,handler:(_req,res) => {
    res.on('close',upstreamClosed);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: first\n\n');
  }});
  await new Promise((resolve,reject) => {
    const req = http.request(f.url+'/v1/responses',{method:'POST'},res => {
      res.once('data',() => { res.destroy(); resolve(); });
    });
    req.on('error',reject);
    req.end('{}');
  });
  await Promise.race([closed,new Promise((_resolve,reject) => {
    const timer = setTimeout(() => reject(Error('upstream stayed open after client disconnect')),3000);
    timer.unref();
  })]);
});

test('gateway connection errors and inactivity timeouts yield a safe error',async t => {
  const f = await fixture(t,{handler:() => {},timeoutMs:25});
  const timeout = await call(f.url+'/v1/models');
  assert.equal(timeout.status,502);
  assert.equal(timeout.body.includes(key),false);
  f.backend.closeAllConnections();
  await new Promise(resolve => f.backend.close(resolve));
  assert.equal((await call(f.url+'/v1/models')).status,502);
});

test('WebSocket upgrade receives 426 without forwarding credentials',async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve,reject) => {
    const socket = net.connect(f.port,'127.0.0.1');
    let data = '';
    socket.on('connect',() => socket.write(`GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.on('data',chunk => data += chunk);
    socket.on('end',() => resolve(data));
    socket.on('error',reject);
  });
  assert.match(result,/^HTTP\/1\.1 426 /);
  assert.equal(f.seen.length,0);
});

test('startup rejects destinations containing secrets or unfixed paths',() => {
  for (const upstreamUrl of ['https://user:pass@example.test/v1','https://example.test/v1?token=fixture',
    'https://example.test/v1#fixture','https://example.test/elsewhere','file:///v1'])
    assert.throws(() => createNativeBridge({upstreamUrl,key}));
  for (const maxRequestBytes of [0,-1,268435457,1.5])
    assert.throws(() => createNativeBridge({upstreamUrl:'http://127.0.0.1:18787/v1',key,maxRequestBytes}));
  assert.throws(() => createNativeBridge({upstreamUrl:'http://127.0.0.1:18787/v1',key:'short'}));
});
