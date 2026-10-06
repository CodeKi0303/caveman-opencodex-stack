import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import http from 'node:http';
import {createControlPanel} from '../scripts/control-panel.mjs';

async function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'caveman-control-')),dir=path.join(home,'caveman-stack');fs.mkdirSync(dir);
 const key='private-test-key-'.repeat(4),keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,key);
 const configPath=path.join(dir,'native-bridge.json');fs.writeFileSync(configPath,JSON.stringify({upstreamUrl:'http://server.test/v1',keyFile,port:18788}));
 const calls=[],state={};
 const server=createControlPanel({configPath,fetchFn:async(url,opts)=>{
  if(url.endsWith('/healthz'))return Response.json({service:'caveman-native-bridge',controlVersion:1});
  if(state.reject)return new Response('',{status:401});
  assert(opts.headers['x-caveman-gateway-key']);return Response.json({capabilities:{compressionSwitch:true}});
 },client:async args=>{calls.push(args);if(state.clientFails)throw Error('fixture secret must not escape');return {ok:true,catalogChanged:false,warnings:[]};},remote:async(_c,a,args)=>{calls.push({a,args});return {ok:true};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();assert(path.dirname(home)===fs.realpathSync(os.tmpdir())||path.dirname(home)===os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}`,html=await fetch(url).then(r=>r.text()),token=/name="control-token" content="([a-f0-9]+)"/.exec(html)[1];
 const call=(route,body,headers={})=>fetch(url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {home,dir,key,configPath,calls,state,url,call};
}
test('control panel rejects cross-origin, rebound host and missing CSRF; never returns stored key',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.url+'/api/status')).status,403);
 assert.equal((await f.call('status',undefined,{origin:'https://attacker.test'})).status,403);
 const rebound=await new Promise(resolve=>http.get(f.url,{headers:{host:'attacker.test'}},r=>{r.resume();resolve(r.statusCode);}));assert.equal(rebound,403);
 assert.equal((await f.call('status',undefined,{'sec-fetch-site':'cross-site'})).status,403);
 const status=await f.call('status').then(r=>r.text());assert(!status.includes(f.key));assert(JSON.parse(status).settings.keyConfigured);
 const page=await fetch(f.url);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('settings validate the destination and atomically switch bridge, key and client settings',async t=>{
 const f=await fixture(t),next='new-private-fixture-'.repeat(4);
 const response=await f.call('settings',{upstreamUrl:'https://new.test/v1/',key:next,compression:false});assert.equal(response.status,200);
 const config=JSON.parse(fs.readFileSync(f.configPath));assert.equal(config.upstreamUrl,'https://new.test/v1');assert.equal(config.compression,false);assert.equal(fs.readFileSync(config.keyFile,'utf8'),next);
 assert(f.calls[0].includes('openai'));assert(f.calls[0].includes('https://new.test/v1'));assert(!JSON.stringify(await response.json()).includes(next));
 const status=await f.call('status').then(r=>r.text());assert(!status.includes(next));
});
test('failed authentication or client update preserves old connection and removes unused new keys',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.configPath,'utf8'),body={upstreamUrl:'https://new.test/v1',key:'changed-fixture-key-'.repeat(4),compression:true};
 f.state.reject=true;assert.equal((await f.call('settings',body)).status,400);assert.equal(fs.readFileSync(f.configPath,'utf8'),before);
 f.state.reject=false;f.state.clientFails=true;const response=await f.call('settings',body);assert.equal(response.status,400);assert(!(await response.text()).includes('fixture secret'));
 assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)),JSON.parse(before));assert.equal(fs.readdirSync(f.dir).filter(f=>f.startsWith('gateway-key-')).length,0);
});
test('updates need a valid fixed component, semantic version and explicit confirmation',async t=>{
 const f=await fixture(t);
 for(const body of [{component:'shell',version:'1.2.3',confirm:true},{component:'caveman',version:'$(id)',confirm:true},{component:'caveman',version:'1.2.3'}])assert.equal((await f.call('update',body)).status,400);
 assert.equal((await f.call('update',{component:'caveman',version:'1.2.3',confirm:true})).status,202);
 await new Promise(r=>setTimeout(r,20));assert.equal((await f.call('status').then(r=>r.json())).job.status,'succeeded');assert.deepEqual(f.calls[0],{a:'update',args:{component:'caveman',version:'1.2.3'}});
});
