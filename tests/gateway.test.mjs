import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createGateway,addressPolicy} from '../src/gateway.mjs';
import {createCatalogRefresher} from '../src/catalog-refresh.mjs';
import TOML from '@iarna/toml';

const key='a'.repeat(64);
async function fixture(t,limit=1024,options={}){
  const seen=[];
  const backend=http.createServer((q,s)=>{const chunks=[];q.on('data',x=>chunks.push(x));q.on('end',()=>{
    seen.push({url:q.url,headers:q.headers,body:Buffer.concat(chunks).toString()});
    s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: first\n\n');setTimeout(()=>s.end('data: done\n\n'),5);
  });});backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-test-'));const catalog=path.join(directory,'models.json');
  fs.writeFileSync(catalog,JSON.stringify({models:[{slug:'fixture',display_name:'Fixture',visibility:'list'}]}));
  const ports=[];
  const gateway=createGateway({key,maxRequestBytes:limit,catalogPath:catalog,...options,request:(opts,cb)=>{ports.push(opts.port);return http.request({...opts,port:backend.address().port},cb);}});
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  t.after(()=>{gateway.closeAllConnections();gateway.close();backend.closeAllConnections();backend.close();fs.rmSync(directory,{recursive:true});});
  return {url:'http://127.0.0.1:'+gateway.address().port,ports,seen,catalog};
}
test('network allowlist IPv4/IPv6 and mapped addresses',()=>{
  const allow=addressPolicy('10.20.0.0/16,::1/128');assert(allow('::ffff:10.20.1.9'));assert(allow('::1'));assert(!allow('10.21.1.9'));
});

test('invalid client authentication modes fail before creating a gateway',()=>{
  for(const clientAuthMode of ['',null,false,'automatic','SERVER'])
    assert.throws(()=>createGateway({key,clientAuthMode}),/Invalid client authentication mode/);
});

test('gateway defaults to 512 MiB and honors a lower limit',async t=>{
  for(const maxRequestBytes of [undefined,268435456]){
    let forwarded=0;
    const gateway=createGateway({key,maxRequestBytes,request:()=>{forwarded++;throw Error('Unexpected upstream request');}});
    t.after(()=>{gateway.closeAllConnections();gateway.close();});
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    const url=`http://127.0.0.1:${gateway.address().port}`;
    const limit=maxRequestBytes??Number(process.env.MAX_REQUEST_BYTES||536870912);
    assert.equal((await fetch(url+'/healthz').then(r=>r.json())).max_request_bytes,limit);
    const refusal=await new Promise((resolve,reject)=>{
      const req=http.request(url+'/v1/responses',{method:'POST',headers:{
        'x-caveman-gateway-key':key,'content-length':String(limit+1)}},res=>{
        let body='';res.on('data',chunk=>{body+=chunk;});res.on('error',reject);
        res.on('end',()=>resolve({status:res.statusCode,body}));
      });
      req.on('error',reject);req.end();
    });
    assert.equal(refusal.status,413);
    assert.equal(JSON.parse(refusal.body).error.limit_bytes,limit);
    assert.equal(forwarded,0);
  }
});

test('gateway rejects invalid limits and settings above 512 MiB',()=>{
  for(const maxRequestBytes of [0,-1,536870913,1.5,NaN,Infinity])
    assert.throws(()=>createGateway({key,maxRequestBytes}),/Invalid request limit/);
});

test('server authentication strips client credentials on compression and bypass routes without changing bodies or SSE',async t=>{
  const f=await fixture(t,1024,{clientAuthMode:'server'});
  const credentials={authorization:'Bearer client-fixture','chatgpt-account-id':'account-fixture',
    'x-api-key':'api-fixture','openai-organization':'org-fixture','openai-project':'project-fixture',
    cookie:'session=fixture',cookie2:'session2=fixture','api-key':'legacy-key-fixture',
    'x-oai-attestation':'caller-attestation','x-openai-agent-assertion':'caller-assertion'};
  const headers={...credentials,'x-caveman-gateway-key':key,'content-type':'application/json',
    'x-openai-subagent':'collab_spawn','x-codex-turn-metadata':'{"subagent_kind":"thread_spawn"}'};
  const body=JSON.stringify({input:'서버 인증 검증',stream:true});
  const routes=[
    ['POST','/v1/responses','on',8787,'/compat/opencodex/v1/responses'],
    ['POST','/v1/responses','off',10101,'/v1/responses'],
    ...['images/generations','images/edits','alpha/search','responses/compact']
      .map(p=>['POST','/v1/'+p,'on',10101,'/v1/'+p]),
    ['GET','/v1/models?client_version=fixture','on',10101,'/v1/models?client_version=fixture'],
  ];
  for(const [method,url,compression,port,upstreamPath] of routes){
    const response=await fetch(f.url+url,{method,headers:{...headers,'x-caveman-compression':compression},
      ...(method==='POST'?{body}:{})});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'text/event-stream');
    assert.equal(await response.text(),'data: first\n\ndata: done\n\n');
    const request=f.seen.at(-1);
    assert.equal(f.ports.at(-1),port);assert.equal(request.url,upstreamPath);
    assert.equal(request.body,method==='POST'?body:'');
    for(const name of [...Object.keys(credentials),'x-caveman-gateway-key','x-caveman-compression'])
      assert.equal(request.headers[name],undefined,`${method} ${url}: ${name}`);
    for(const name of ['x-openai-subagent','x-codex-turn-metadata'])
      assert.equal(request.headers[name],headers[name]);
  }
  const info=await fetch(f.url+'/v1/stack-info',{headers}).then(r=>r.json());
  assert.equal(info.clientAuthMode,'server');assert.equal(info.capabilities.compressionSwitch,true);
  const count=f.seen.length;
  for(const [method,url] of routes){
    const response=await fetch(f.url+url,{method,headers:credentials,...(method==='POST'?{body}:{})});
    assert.equal(response.status,401);await response.text();
  }
  assert.equal((await fetch(f.url+'/v1/stack-info',{headers:credentials})).status,401);
  assert.equal(f.seen.length,count);
});

test('forward mode remains the default and explicitly preserves client authentication',async t=>{
  const headers={authorization:'Bearer client-fixture','chatgpt-account-id':'account-fixture',
    'x-api-key':'api-fixture','openai-organization':'org-fixture','openai-project':'project-fixture',
    cookie:'session=fixture','x-caveman-gateway-key':key};
  for(const options of [{},{clientAuthMode:'forward'}]){
    const f=await fixture(t,1024,options);
    const response=await fetch(f.url+'/v1/responses',{method:'POST',headers,body:'{}'});
    assert.equal(response.status,200);await response.text();
    for(const [name,value] of Object.entries(headers))
      assert.equal(f.seen[0].headers[name],name==='x-caveman-gateway-key'?undefined:value);
    const info=await fetch(f.url+'/v1/stack-info',{headers}).then(r=>r.json());
    assert.equal(info.clientAuthMode,'forward');
  }
});

test('authenticated compression selection routes per request and never forwards the control header',async t=>{
  const f=await fixture(t),headers={'x-caveman-gateway-key':key,'content-type':'application/json'};
  assert.equal((await fetch(f.url+'/v1/stack-info')).status,401);
  assert.equal((await fetch(f.url+'/v1/stack-info',{headers}).then(r=>r.json())).capabilities.compressionSwitch,true);
  for(const [mode,port,url] of [['off',10101,'/v1/responses'],['on',8787,'/compat/opencodex/v1/responses']]){
    const r=await fetch(f.url+'/v1/responses',{method:'POST',headers:{...headers,'x-caveman-compression':mode},body:'{}'});await r.text();
    assert.equal(r.status,200);assert.equal(f.ports.at(-1),port);assert.equal(f.seen.at(-1).url,url);assert.equal(f.seen.at(-1).headers['x-caveman-compression'],undefined);
  }
  assert.equal((await fetch(f.url+'/v1/responses',{method:'POST',headers:{...headers,'x-caveman-compression':'invalid'},body:'{}'})).status,400);
});
test('auth guards models, catalog and responses; health remains readable',async t=>{
  const f=await fixture(t);
  for(const endpoint of ['/v1/models','/v1/catalog','/v1/responses'])assert.equal((await fetch(f.url+endpoint)).status,401);
  assert.equal((await fetch(f.url+'/healthz')).status,200);assert.equal(f.seen.length,0);
});
test('Responses stream passes through compression route without gateway credential',async t=>{
  const f=await fixture(t);const r=await fetch(f.url+'/v1/responses',{method:'POST',headers:{'x-caveman-gateway-key':key,'authorization':'Bearer fixture'},body:'{}'});
  assert.equal(await r.text(),'data: first\n\ndata: done\n\n');assert.equal(f.ports[0],8787);
  assert.equal(f.seen[0].url,'/compat/opencodex/v1/responses');assert.equal(f.seen[0].headers.authorization,'Bearer fixture');assert.equal(f.seen[0].headers['x-caveman-gateway-key'],undefined);
});

test('catalog supports authenticated HEAD and conditional reads and changes ETag with content',async t=>{
  const f=await fixture(t);const headers={'x-caveman-gateway-key':key};
  const initial=await fetch(f.url+'/v1/catalog',{headers});const etag=initial.headers.get('etag');
  const body=await initial.text();assert.match(etag,/^"[a-f0-9]{64}"$/);
  const head=await fetch(f.url+'/v1/catalog',{method:'HEAD',headers});
  assert.equal(head.status,200);assert.equal(head.headers.get('etag'),etag);
  assert.equal(Number(head.headers.get('content-length')),Buffer.byteLength(body));assert.equal(await head.text(),'');
  for(const condition of [etag,'W/'+etag,'"other", '+etag,'*']) {
    const unchanged=await fetch(f.url+'/v1/catalog',{headers:{...headers,'if-none-match':condition}});
    assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
  }
  assert.equal((await fetch(f.url+'/v1/catalog',{headers:{'if-none-match':etag}})).status,401);
  fs.writeFileSync(f.catalog,JSON.stringify({models:[{slug:'new',display_name:'New'}]}));
  const changed=await fetch(f.url+'/v1/catalog',{headers:{...headers,'if-none-match':etag}});
  assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
  assert.equal((await changed.json()).models[0].slug,'new');
});

test('catalog refresh precedes ETag checks; authentication and refresh failure cannot serve stale success',async t=>{
  let refresh,calls=0,offline=false;
  let catalog={models:[{slug:'test',display_name:'Test',context_window:272000}]};
  const f=await fixture(t,1024,{refreshCatalog:()=>refresh()});
  refresh=createCatalogRefresher({url:'http://upstream.test/v1/models',output:f.catalog,fetchImpl:async()=>{
    calls++;if(offline)throw Error('Private upstream details');return Response.json(catalog);
  }});
  assert.equal((await fetch(f.url+'/v1/catalog')).status,401);assert.equal(calls,0);
  const headers={'x-caveman-gateway-key':key};
  const first=await fetch(f.url+'/v1/catalog',{headers}),etag=first.headers.get('etag');
  assert.equal((await first.json()).models[0].context_window,272000);
  const conditional={...headers,'if-none-match':etag};
  assert.equal((await fetch(f.url+'/v1/catalog',{headers:conditional})).status,304);
  catalog.models[0].context_window=872000;
  const changed=await fetch(f.url+'/v1/catalog',{headers:conditional});
  assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
  assert.equal((await changed.json()).models[0].context_window,872000);
  const saved=fs.readFileSync(f.catalog,'utf8');offline=true;
  const failed=await fetch(f.url+'/v1/catalog',{headers:conditional});
  assert.equal(failed.status,503);assert(!(await failed.text()).includes('Private upstream'));
  assert.equal(fs.readFileSync(f.catalog,'utf8'),saved);
  offline=false;
  const head=await fetch(f.url+'/v1/catalog',{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(f.url+'/v1/stack-info',{headers}).then(r=>r.json())).capabilities.catalogRefreshOnRead,true);
});

test('gateway preserves Codex attribution headers while removing its gateway key',async t=>{
  const f=await fixture(t);
  const metadata={'chatgpt-account-id':'workspace-fixture','x-openai-subagent':'collab_spawn',
    'x-codex-turn-metadata':'{"subagent_kind":"thread_spawn"}'};
  const response=await fetch(f.url+'/v1/responses',{method:'POST',headers:{...metadata,
    'x-caveman-gateway-key':key,authorization:'Bearer fixture'},body:'{}'});
  await response.text();
  for(const [name,value] of Object.entries(metadata))assert.equal(f.seen[0].headers[name],value);
  assert.equal(f.seen[0].headers['x-caveman-gateway-key'],undefined);
});
test('tool allowlist bypasses Caveman; unknown endpoints fail closed',async t=>{
  const f=await fixture(t);
  for(const p of ['images/generations','images/edits','alpha/search','responses/compact']){
    const r=await fetch(f.url+'/v1/'+p,{method:'POST',headers:{'x-caveman-gateway-key':key,'content-type':'application/json'},body:'{"fixture":true}'});assert.equal(r.status,200);await r.text();
  }
  assert.deepEqual(f.ports,[10101,10101,10101,10101]);assert(f.seen.every(x=>x.body==='{"fixture":true}'));
  assert.equal((await fetch(f.url+'/v1/arbitrary',{headers:{'x-caveman-gateway-key':key}})).status,404);
});
test('declared and chunked oversize uploads are bounded',async t=>{
  const f=await fixture(t,16);
  assert.equal((await fetch(f.url+'/v1/responses',{method:'POST',headers:{'x-caveman-gateway-key':key},body:'x'.repeat(17)})).status,413);
  const status=await new Promise((resolve,reject)=>{
    const q=http.request(f.url+'/v1/responses',{method:'POST',headers:{'x-caveman-gateway-key':key}},r=>{r.resume();resolve(r.statusCode);});q.on('error',reject);q.write('1234567890');q.end('1234567890');
  });assert.equal(status,413);
});
test('catalog export and local client keep TOML root keys outside tables',async t=>{
  const f=await fixture(t);const {spawn}=await import('node:child_process');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'client-test-'));t.after(()=>fs.rmSync(directory,{recursive:true}));
  fs.writeFileSync(path.join(directory,'key'),key);
  fs.writeFileSync(path.join(directory,'config.toml'),'model = "fixture"\n[features]\nexample = true\n');
  const p=spawn(process.execPath,['scripts/client.mjs','sync','--url',f.url+'/v1','--key-file',path.join(directory,'key'),'--codex-home',directory],{stdio:'pipe'});
  let error='';p.stderr.on('data',x=>error+=x);const [exit]=await once(p,'exit');assert.equal(exit,0,error);
  const cfg=TOML.parse(fs.readFileSync(path.join(directory,'config.toml'),'utf8'));
  assert.equal(cfg.model_catalog_json,path.join(directory,'opencodex-catalog.json').replaceAll('\\','/'));
  assert.equal(cfg.model,'fixture');assert.equal(cfg.features.example,true);assert.equal(cfg.features.model_catalog_json,undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'opencodex-catalog.json'))).models[0].slug,'fixture');
});
