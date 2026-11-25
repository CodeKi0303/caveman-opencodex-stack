import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {createNativeBridge} from '../src/native-bridge.mjs';
import {createGateway} from '../src/gateway.mjs';

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
async function fixture(t, {handler, maxRequestBytes = 1024, timeoutMs = 1000, clientAuthMode = 'forward', getSettings} = {}) {
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
  const bridge = createNativeBridge({upstreamUrl,key,maxRequestBytes,timeoutMs,clientAuthMode,
    ...(getSettings?{getSettings:()=>getSettings({upstreamUrl,key})}:{})});
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

test('server authentication removes client credentials for every supported route without changing payloads',async t => {
  const f = await fixture(t,{clientAuthMode:'server'});
  const credentials = {authorization:'Bearer oauth-fixture','chatgpt-account-id':'account-fixture',
    'x-api-key':'api-key-fixture','api-key':'legacy-key-fixture',
    'x-oai-attestation':'caller-attestation','x-openai-agent-assertion':'caller-assertion',
    'openai-organization':'organization-fixture',
    'openai-project':'project-fixture',cookie:'cookie-fixture',cookie2:'cookie2-fixture'};
  const headers = {...credentials,'x-caveman-gateway-key':'caller-key','content-type':'application/json',
    'x-codex-turn-metadata':'{"subagent_kind":"thread_spawn"}','x-openai-subagent':'collab_spawn'};
  const body='{"input":"fixture","image":"data:image/png;base64,c3ludGhldGlj"}';
  for (const route of ['responses','responses/compact','images/generations','images/edits','alpha/search']) {
    assert.equal((await call(f.url+'/v1/'+route,{method:'POST',body,headers})).status,200);
    assert.equal(f.seen.at(-1).body,body);
  }
  for (const [route,method] of [['models?client_version=fixture','GET'],['catalog','GET'],['catalog','HEAD']])
    assert.equal((await call(f.url+'/v1/'+route,{method,headers})).status,200);
  assert.equal(f.seen.length,8);
  for (const record of f.seen) {
    for (const name of Object.keys(credentials)) assert.equal(record.headers[name],undefined,name);
    assert.equal(record.headers['x-caveman-gateway-key'],key);
    assert.equal(record.headers['x-caveman-compression'],'on');
    assert.equal(record.headers['x-codex-turn-metadata'],headers['x-codex-turn-metadata']);
    assert.equal(record.headers['x-openai-subagent'],'collab_spawn');
  }
  assert.equal(JSON.parse((await call(f.url+'/healthz')).body).clientAuthMode,'server');
});

test('client authentication policy reloads per request and rejects invalid modes before forwarding',async t => {
  let mode;
  const f = await fixture(t,{getSettings:base=>({...base,clientAuthMode:mode})});
  const headers={authorization:'Bearer oauth-fixture','chatgpt-account-id':'account-fixture'};
  for (const [selected,expected] of [[undefined,'Bearer oauth-fixture'],['server',undefined],['forward','Bearer oauth-fixture']]) {
    mode=selected;
    assert.equal((await call(f.url+'/v1/responses',{method:'POST',body:'{}',headers})).status,200);
    assert.equal(f.seen.at(-1).headers.authorization,expected);
    assert.equal(JSON.parse((await call(f.url+'/healthz')).body).clientAuthMode,selected??'forward');
  }
  for (const invalid of ['typo','',null,false,{}]) {
    mode=invalid;
    assert.equal((await call(f.url+'/v1/responses',{method:'POST',body:'{}',headers})).status,503);
    assert.equal((await call(f.url+'/healthz')).status,503);
  }
  assert.equal(f.seen.length,3);
  mode='server';
  assert.equal((await call(f.url+'/v1/responses',{method:'POST',body:'{}',headers})).status,200);
  assert.equal(f.seen.at(-1).headers.authorization,undefined);
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
    upstream:f.upstreamUrl,upstreamUrl:f.upstreamUrl,pid:process.pid,max_request_bytes:1024,compression:true,clientAuthMode:'forward',controlVersion:1});
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

test('bridge and gateway preserve OpenCodex accounting metadata while removing caller authentication',async t=>{
  const turnMetadata=JSON.stringify({installation_id:'fixture-installation',turn_source:'thread_spawn'});
  const body=JSON.stringify({model:'fixture',input:'Synthetic request.',stream:true,client_metadata:{
    'x-codex-installation-id':'fixture-installation','x-codex-turn-metadata':turnMetadata,
    custom_field:{preserve:true},
  }});
  const responseMetadata={'x-reasoning-included':'true','x-codex-turn-state':'ocx-fixture-next-turn',
    'x-codex-primary-used-percent':'12','x-codex-primary-window-minutes':'300',
    'x-codex-primary-reset-at':'1800000000','retry-after':'2'};
  const sse='data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:250000,output_tokens:500,total_tokens:250500}}})+'\n\n';
  let received;
  const backend=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      received={url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};
      res.writeHead(200,{'content-type':'text/event-stream',...responseMetadata,
        authorization:'Bearer response-must-not-escape','x-oai-attestation':'response-must-not-escape'});
      res.end(sse);
    });
  });
  const gateway=createGateway({key,clientAuthMode:'server',request:(options,callback)=>{
    assert.equal(options.port,10101);
    return http.request({...options,port:backend.address().port},callback);
  }});
  let bridge;
  t.after(()=>{for(const server of [bridge,gateway,backend]){server?.closeAllConnections();server?.close();}});
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const upstreamUrl=`http://127.0.0.1:${gateway.address().port}/v1`;
  bridge=createNativeBridge({upstreamUrl,key,getSettings:()=>({upstreamUrl,key,clientAuthMode:'server',compression:false})});
  bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
  const result=await call(`http://127.0.0.1:${bridge.address().port}/v1/responses`,{method:'POST',body,headers:{
    'content-type':'application/json','x-caveman-gateway-key':'caller-key-must-be-replaced',
    authorization:'Bearer caller-fixture','chatgpt-account-id':'caller-account',
    'x-oai-attestation':'caller-attestation','x-openai-agent-assertion':'caller-assertion',
    'x-codex-turn-metadata':turnMetadata,'x-codex-turn-state':'ocx-fixture-prior-turn',
  }});
  assert.equal(result.status,200);assert.equal(result.body,sse);
  for(const [name,value] of Object.entries(responseMetadata))assert.equal(result.headers[name],value,name);
  assert.equal(received.url,'/v1/responses');assert.equal(received.body,body);
  assert.equal(received.headers['x-codex-turn-metadata'],turnMetadata);
  assert.equal(received.headers['x-codex-turn-state'],'ocx-fixture-prior-turn');
  for(const name of ['authorization','chatgpt-account-id','x-oai-attestation','x-openai-agent-assertion','x-caveman-gateway-key']){
    assert.equal(received.headers[name],undefined,name+' request');assert.equal(result.headers[name],undefined,name+' response');
  }
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

test('server authentication preserves incremental SSE while stripping client credentials',async t => {
  let finishStream;
  const f = await fixture(t,{clientAuthMode:'server',timeoutMs:10000,handler:(_req,res) => {
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: first\n\n');
    finishStream=()=>res.end('data: last\n\n');
  }});
  const response=await fetch(f.url+'/v1/responses',{method:'POST',body:'{}',headers:{
    authorization:'Bearer oauth-fixture','chatgpt-account-id':'account-fixture'}});
  const reader=response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'data: first\n\n');
  assert.equal(f.seen[0].headers.authorization,undefined);
  assert.equal(f.seen[0].headers['chatgpt-account-id'],undefined);
  assert.equal(f.seen[0].headers['x-caveman-gateway-key'],key);
  finishStream();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'data: last\n\n');
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

test('bridge defaults to 512 MiB and honors a lower limit',async t => {
  for (const maxRequestBytes of [undefined,268435456]) {
    const bridge=createNativeBridge({upstreamUrl:'http://127.0.0.1:1/v1',key,maxRequestBytes});
    t.after(()=>{bridge.closeAllConnections();bridge.close();});
    bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
    const url=`http://127.0.0.1:${bridge.address().port}`;
    const limit=maxRequestBytes??536870912;
    assert.equal(JSON.parse((await call(url+'/healthz')).body).max_request_bytes,limit);
    const refused=await call(url+'/v1/responses',{method:'POST',headers:{'content-length':String(limit+1)}});
    assert.equal(refused.status,413);
    assert.match(refused.body,/Request body exceeds bridge limit/);
  }
});

test('default bridge and gateway stream a body above 256 MiB to a local mock', {timeout:30000}, async t => {
  const size=268435457;
  let received=0;
  const backend=http.createServer((req,res)=>{
    req.on('data',chunk=>{received+=chunk.length;});
    req.on('end',()=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({received})));
  });
  t.after(()=>{backend.closeAllConnections();backend.close();});
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const gateway=createGateway({key,request:(options,callback)=>
    http.request({...options,hostname:'127.0.0.1',port:backend.address().port},callback)});
  t.after(()=>{gateway.closeAllConnections();gateway.close();});
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const bridge=createNativeBridge({key,
    upstreamUrl:`http://127.0.0.1:${gateway.address().port}/v1`});
  t.after(()=>{bridge.closeAllConnections();bridge.close();});
  bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
  const req=http.request(`http://127.0.0.1:${bridge.address().port}/v1/responses`,{method:'POST'});
  const response=new Promise((resolve,reject)=>{
    req.on('error',reject);
    req.on('response',res=>{
      let body='';
      res.on('data',chunk=>{body+=chunk;});
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,body}));
    });
  });
  // Reuse a small buffer and honor backpressure; no full-size body is retained.
  const chunk=Buffer.alloc(64*1024,120);
  const upload=(async()=>{
    for(let remaining=size;remaining>0;){
      const length=Math.min(chunk.length,remaining);
      if(!req.write(chunk.subarray(0,length)))await once(req,'drain');
      remaining-=length;
    }
    req.end();
  })();
  const [result]=await Promise.all([response,upload]);
  assert.equal(result.status,200);
  assert.equal(JSON.parse(result.body).received,size);
  assert.equal(received,size);
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
  for (const maxRequestBytes of [0,-1,536870913,1.5,NaN,Infinity])
    assert.throws(() => createNativeBridge({upstreamUrl:'http://127.0.0.1:18787/v1',key,maxRequestBytes}));
  for (const clientAuthMode of ['typo','',null,false,{}])
    assert.throws(() => createNativeBridge({upstreamUrl:'http://127.0.0.1:18787/v1',key,clientAuthMode}));
  assert.throws(() => createNativeBridge({upstreamUrl:'http://127.0.0.1:18787/v1',key:'short'}));
});
