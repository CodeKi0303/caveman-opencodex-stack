import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createControlPanel,remoteCommand,validateManagement} from '../scripts/control-panel.mjs';
const repo=fs.realpathSync(fileURLToPath(new URL('..',import.meta.url)));

async function fixture(t,{management,platform}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'caveman-control-')),dir=path.join(home,'caveman-stack');fs.mkdirSync(dir);
 const key='private-test-key-'.repeat(4),keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,key);
 const configPath=path.join(dir,'native-bridge.json');fs.writeFileSync(configPath,JSON.stringify({upstreamUrl:'http://server.test/v1',keyFile,port:18788,...(management?{management}:{})}));
 const calls=[],state={};
 const server=createControlPanel({configPath,platform,fetchFn:async(url,opts)=>{
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
test('Linux direct management is bound to the running repository and cannot be enabled or redirected by the web form',async t=>{
 const local={mode:'local',repo},f=await fixture(t,{management:local,platform:'linux'});
 assert.deepEqual(validateManagement(local,{platform:'linux'}),local);
 for(const [value,platform] of [[local,'win32'],[{mode:'local',repo:os.tmpdir()},'linux'],[{mode:'local',repo:'.'},'linux']])assert.throws(()=>validateManagement(value,{platform}),/INVALID_LOCAL_MANAGEMENT/);
 const body={upstreamUrl:'http://server.test/v1',compression:false,management:local};
 assert.equal((await f.call('settings',body)).status,200);assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)).management,local);
 for(const upstreamUrl of ['http://different.test/v1','http://server.test:18787/v1']){
  const rejected=await f.call('settings',{...body,upstreamUrl});assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,'LOCAL_MANAGEMENT_LOCKED');
 }
 assert.equal((await f.call('settings',{...body,upstreamUrl:body.upstreamUrl+'/',key:'updated-local-fixture-key-'.repeat(3),compression:true})).status,200);
 assert.equal(JSON.parse(fs.readFileSync(f.configPath)).compression,true);
 for(const management of [null,{mode:'local',repo:os.tmpdir()},{host:'root@server.test',keyFile:path.join(f.dir,'key'),repo:'/home/stack'}]){
  const rejected=await f.call('settings',{...body,management});assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,'LOCAL_MANAGEMENT_LOCKED');
 }
 const unmanaged=await fixture(t,{platform:'linux'});assert.equal((await unmanaged.call('settings',body)).status,400);
 assert.deepEqual((await f.call('status').then(r=>r.json())).settings.management,local);
});
test('doctor explicitly checks the native OpenAI bridge; all server actions retain their fixed routing',async t=>{
 const f=await fixture(t,{management:{mode:'local',repo},platform:'linux'});
 assert.equal((await f.call('doctor',{})).status,202);await new Promise(r=>setTimeout(r,10));
 assert(f.calls[0].includes('--provider'));assert(f.calls[0].includes('openai'));assert(f.calls[0].includes('--bridge-url'));assert(f.calls[0].includes('http://127.0.0.1:18788/v1'));
 for(const [route,action] of [['check-update','check'],['refresh-server-catalog','catalog']]){
  assert.equal((await f.call(route,{})).status,202);await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.calls.at(-1),{a:action,args:{}});
 }
});
function processFixture(result={ok:true}, {hang=false,error=false}={}){
 const calls=[];let killed=false;
 const spawnFn=(command,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{killed=true;};
  const call={command,args,options,input:''};calls.push(call);child.stdin.on('data',data=>{call.input+=data;});
  child.stdin.on('finish',()=>{if(hang)return;queueMicrotask(()=>{if(error)child.emit('error',Error('private process error'));else{child.stdout.end(JSON.stringify(result));child.emit('close',result.ok?0:1);}});});
  return child;
 };
 return {calls,spawnFn,killed:()=>killed};
}
test('direct management launches only the fixed Python helper with JSON stdin and no SSH credentials or shell',async()=>{
 const f=processFixture({ok:true,components:{caveman:{current:'1.2.3'}}}),settings={upstreamUrl:'http://server.test/v1',management:{mode:'local',repo}};
 const result=await remoteCommand(settings,'check',{}, {platform:'linux',spawnFn:f.spawnFn});assert(result.ok);
 assert.equal(f.calls[0].command,'python3');assert.deepEqual(f.calls[0].args,[path.join(repo,'scripts','server-control.py')]);assert.notEqual(f.calls[0].options.shell,true);
 assert.deepEqual(JSON.parse(f.calls[0].input),{repo,action:'check'});
 for(const [action,args] of [['connection',{}],['check',{repo:'/tmp/other'}],['update',{component:'shell',version:'1.2.3'}],['update',{component:'caveman',version:'$(id)'}]])assert.throws(()=>remoteCommand(settings,action,args,{platform:'linux',spawnFn:f.spawnFn}));
 assert.equal(f.calls.length,1);
});
test('direct management errors and timeout are sanitized, while legacy SSH keeps strict host verification',async t=>{
 const settings={upstreamUrl:'http://server.test/v1',management:{mode:'local',repo}};
 const failed=processFixture({ok:false,error:'sensitive detail'});await assert.rejects(remoteCommand(settings,'catalog',{}, {platform:'linux',spawnFn:failed.spawnFn}),/^Error: SERVER_OPERATION_FAILED$/);
 const missing=processFixture(undefined,{error:true});await assert.rejects(remoteCommand(settings,'check',{}, {platform:'linux',spawnFn:missing.spawnFn}),/LOCAL_MANAGEMENT_UNAVAILABLE/);
 const hanging=processFixture(undefined,{hang:true});await assert.rejects(remoteCommand(settings,'check',{}, {platform:'linux',spawnFn:hanging.spawnFn,timeoutMs:5}),/LOCAL_MANAGEMENT_TIMEOUT/);assert(hanging.killed());
 const panel=await fixture(t),ssh=processFixture();
 await remoteCommand({upstreamUrl:'http://server.test/v1',management:{host:'root@server.test',keyFile:path.join(panel.dir,'key'),repo:'/home/stack'}},'check',{}, {platform:'win32',spawnFn:ssh.spawnFn});
 assert.equal(ssh.calls[0].command,'ssh');assert(ssh.calls[0].args.includes('StrictHostKeyChecking=yes'));assert(ssh.calls[0].args.includes('BatchMode=yes'));assert(!ssh.calls[0].input.includes(panel.key));
});
