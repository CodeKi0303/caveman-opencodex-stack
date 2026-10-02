import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createGateway,addressPolicy} from '../src/gateway.mjs';

const key='a'.repeat(64);
async function fixture(t,limit=1024){
  const seen=[];
  const backend=http.createServer((q,s)=>{const chunks=[];q.on('data',x=>chunks.push(x));q.on('end',()=>{
    seen.push({url:q.url,headers:q.headers,body:Buffer.concat(chunks).toString()});
    s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: first\n\n');setTimeout(()=>s.end('data: done\n\n'),5);
  });});backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-test-'));const catalog=path.join(directory,'models.json');
  fs.writeFileSync(catalog,JSON.stringify({models:[{slug:'fixture',display_name:'Fixture',visibility:'list'}]}));
  const ports=[];
  const gateway=createGateway({key,maxRequestBytes:limit,catalogPath:catalog,request:(opts,cb)=>{ports.push(opts.port);return http.request({...opts,port:backend.address().port},cb);}});
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  t.after(()=>{gateway.closeAllConnections();gateway.close();backend.closeAllConnections();backend.close();fs.rmSync(directory,{recursive:true});});
  return {url:'http://127.0.0.1:'+gateway.address().port,ports,seen};
}
test('network allowlist IPv4/IPv6 and mapped addresses',()=>{
  const allow=addressPolicy('10.20.0.0/16,::1/128');assert(allow('::ffff:10.20.1.9'));assert(allow('::1'));assert(!allow('10.21.1.9'));
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
  const cfg=fs.readFileSync(path.join(directory,'config.toml'),'utf8');assert(cfg.startsWith('model_catalog_json = '));assert(cfg.includes('[features]\nexample = true'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'opencodex-catalog.json'))).models[0].slug,'fixture');
});
