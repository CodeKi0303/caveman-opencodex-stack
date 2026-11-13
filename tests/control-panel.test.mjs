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

async function fixture(t,{management,platform,remoteClients}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'caveman-control-')),dir=path.join(home,'caveman-stack');fs.mkdirSync(dir);
 const key='private-test-key-'.repeat(4),keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,key);
 const configPath=path.join(dir,'native-bridge.json');fs.writeFileSync(configPath,JSON.stringify({upstreamUrl:'http://server.test/v1',keyFile,port:18788,...(management?{management}:{})}));
 const calls=[],state={};
 const server=createControlPanel({configPath,platform,remoteClients,fetchFn:async(url,opts)=>{
  if(url.endsWith('/healthz')){if(state.bridgeDown)throw Error('private bridge detail');return Response.json({service:'caveman-native-bridge',controlVersion:1});}
  if(state.reject)return new Response('',{status:401});
  assert(opts.headers['x-caveman-gateway-key']);return Response.json({capabilities:{compressionSwitch:true}});
 },client:async args=>{calls.push(args);if(state.clientFails)throw Error('fixture secret must not escape');return state.clientResult??{ok:true,catalogChanged:false,warnings:[]};},remote:async(_c,a,args)=>{calls.push({a,args});if(a==='status'){if(state.managementFails)throw Error('private management detail');if(state.statusWait)await state.statusWait;return {ok:true,authentication:{mode:state.authMode??'pool',source:'server',secret:key}};}if(state.serverFails)throw Error('SERVER_OPERATION_FAILED');return state.serverResult??{ok:true};}});
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
test('status refreshes authentication, health alerts and catalog without changing settings or returning credentials',async t=>{
 const f=await fixture(t,{management:{mode:'local',repo},platform:'linux'}),before=fs.readFileSync(f.configPath,'utf8');
 let status=await f.call('status').then(r=>r.json());
 assert.deepEqual(status.authentication,{mode:'pool',source:'server'});assert(!Number.isNaN(Date.parse(status.checkedAt)));
 assert.deepEqual(status.alerts.map(a=>a.id),['catalog-empty']);
 f.state.reject=true;f.state.bridgeDown=true;f.state.managementFails=true;
 const failed=await f.call('status').then(r=>r.text());status=JSON.parse(failed);
 assert.equal(status.gateway.error,'GATEWAY_KEY_REJECTED');assert.equal(status.authentication.mode,'unknown');
 assert.deepEqual(status.alerts.map(a=>a.id),['bridge-unavailable','gateway-unavailable','authentication-unknown','catalog-empty']);
 assert(!failed.includes(f.key));assert(!failed.includes('private management'));assert(!failed.includes('private bridge'));
 f.state.reject=false;f.state.bridgeDown=false;f.state.managementFails=false;f.state.authMode='direct';
 fs.writeFileSync(path.join(f.home,'opencodex-catalog.json'),JSON.stringify({models:[{id:'example'}]}));
 status=await f.call('status').then(r=>r.json());
 assert.deepEqual(status.authentication,{mode:'direct',source:'server'});assert.deepEqual(status.alerts,[]);assert.equal(status.catalog.count,1);
 assert.equal(fs.readFileSync(f.configPath,'utf8'),before);assert(f.calls.every(c=>c.a==='status'));
 f.state.authMode='unexpected';status=await f.call('status').then(r=>r.json());assert.equal(status.authentication.source,'unavailable');
});
test('unmanaged clients do not guess an authentication mode or launch a server action',async t=>{
 const f=await fixture(t),status=await f.call('status').then(r=>r.json());
 assert.deepEqual(status.authentication,{mode:'unknown',source:'unavailable'});assert.deepEqual(f.calls,[]);
});
test('catalog status counts selectable models and refreshes visibility changes without altering catalog metadata',async t=>{
 const f=await fixture(t),file=path.join(f.home,'opencodex-catalog.json');
 const models=Array.from({length:9},(_,i)=>({slug:'model-'+i,visibility:i<3?'list':'hide',metadata:{fixture:i}}));
 models[8]={slug:'auto-review',visibility:'hide',supported_in_api:false,metadata:{purpose:'internal-review'}};
 const write=()=>{const text=JSON.stringify({models,metadata:{source:'fixture'}});fs.writeFileSync(file,text);return text;};
 let before=write(),modified=fs.statSync(file).mtime.toISOString();
 let status=await f.call('status').then(r=>r.json());
 assert.deepEqual(status.catalog,{count:3,totalCount:9,hiddenCount:6,modified});assert.deepEqual(status.alerts,[]);
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.statSync(file).mtime.toISOString(),modified);
 models[2].visibility='hide';before=write();modified=fs.statSync(file).mtime.toISOString();
 status=await f.call('status').then(r=>r.json());
 assert.deepEqual(status.catalog,{count:2,totalCount:9,hiddenCount:7,modified});
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(f.calls,[]);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)).models.at(-1),models[8]);
});
test('catalog alerts distinguish missing rows from a catalog with every model hidden, and legacy rows remain visible',async t=>{
 const f=await fixture(t),file=path.join(f.home,'opencodex-catalog.json');
 fs.writeFileSync(file,JSON.stringify({models:[{slug:'hidden-model',visibility:'hide'}]}));
 let status=await f.call('status').then(r=>r.json());
 assert.equal(status.catalog.count,0);assert.equal(status.catalog.totalCount,1);assert.equal(status.catalog.hiddenCount,1);
 assert.deepEqual(status.alerts.map(a=>a.id),['catalog-no-selectable']);assert.match(status.alerts[0].message,/선택/);
 fs.writeFileSync(file,JSON.stringify({models:[{slug:'legacy-model'}]}));
 status=await f.call('status').then(r=>r.json());
 assert.equal(status.catalog.count,1);assert.equal(status.catalog.totalCount,1);assert.equal(status.catalog.hiddenCount,0);assert.deepEqual(status.alerts,[]);
 fs.writeFileSync(file,JSON.stringify({models:[]}));status=await f.call('status').then(r=>r.json());
 assert.equal(status.catalog.count,0);assert.equal(status.catalog.totalCount,0);assert.equal(status.catalog.hiddenCount,0);
 assert.deepEqual(status.alerts.map(a=>a.id),['catalog-empty']);assert.deepEqual(f.calls,[]);
});
test('concurrent status requests share one in-flight read without retaining stale results',async t=>{
 const f=await fixture(t,{management:{mode:'local',repo},platform:'linux'});
 let finish;f.state.statusWait=new Promise(resolve=>{finish=resolve;});
 const first=f.call('status'),second=f.call('status');
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.length,1);
 finish();await Promise.all([first,second]);
 f.state.authMode='direct';assert.equal((await f.call('status').then(r=>r.json())).authentication.mode,'direct');assert.equal(f.calls.length,2);
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

test('remote client registry and actions keep local credentials private and preserve per-PC failures',async t=>{
 const remoteCalls=[],f=await fixture(t,{remoteClients:async(targets,ids,action,settings)=>{
  remoteCalls.push({targets,ids,action,settings});
  return {ok:false,action,results:ids.map((id,i)=>({id,ok:i===0,...(i?{error:'REMOTE_SSH_FAILED'}:{result:{ok:true,applied:true}})}))};
 }});
 const before=fs.readFileSync(f.configPath,'utf8');
 const registered=[];
 for(const host of ['me@client-a.test','me@client-b.test']){
  const response=await f.call('remote-clients',{target:{host,configPath:'/home/me/.codex/config.toml'}});
  assert.equal(response.status,200);registered.push((await response.json()).remoteClients.at(-1));
 }
 assert.equal(registered[0].configPath,'/home/me/.codex/caveman-stack/native-bridge.json');
 assert.equal(fs.readFileSync(f.configPath,'utf8'),before);
 let status=await f.call('status').then(r=>r.json());
 assert.equal(status.capabilities.remoteClientManagement,1);assert.equal(status.remoteClients.length,2);assert(!JSON.stringify(status).includes(f.key));
 const ids=registered.map(t=>t.id);
 for(const body of [{action:'shell',ids},{action:'apply',ids},{action:'status',ids:['unknown']},{action:'sync',ids:[ids[0],ids[0]]}]){
  assert.equal((await f.call('remote-client-action',body)).status,400);
 }
 assert.equal(remoteCalls.length,0);
 assert.equal((await f.call('remote-client-action',{action:'apply',ids,confirm:true})).status,202);
 await new Promise(r=>setTimeout(r,15));status=await f.call('status').then(r=>r.json());
 assert.equal(remoteCalls.length,1);assert.equal(remoteCalls[0].settings.key,f.key);assert.equal(remoteCalls[0].settings.upstreamUrl,'http://server.test/v1');
 assert.equal(status.job.status,'failed');assert.equal(status.job.result.results.length,2);assert(status.job.result.results[0].ok);
 assert(!JSON.stringify(status).includes(f.key));
 assert.equal((await f.call('remote-clients',{remove:ids[0]})).status,200);
 assert.equal((await f.call('status').then(r=>r.json())).remoteClients.length,1);
 assert.equal(fs.readFileSync(f.configPath,'utf8'),before);
});

test('remote configuration applies authentication mode without touching management or OAuth',async t=>{
 const f=await fixture(t,{management:{mode:'local',repo},platform:'linux'});
 fs.writeFileSync(path.join(f.home,'auth.json'),'private-login-fixture');
 const body={upstreamUrl:'http://server.test/v1',compression:false,clientAuthMode:'server'};
 assert.equal((await f.call('settings',{...body,clientAuthMode:'invalid'})).status,400);
 assert.equal((await f.call('settings',body)).status,200);
 const config=JSON.parse(fs.readFileSync(f.configPath));
 assert.equal(config.clientAuthMode,'server');assert.deepEqual(config.management,{mode:'local',repo});
 assert.equal((await f.call('status').then(r=>r.json())).settings.clientAuthMode,'server');
 assert.equal(fs.readFileSync(path.join(f.home,'auth.json'),'utf8'),'private-login-fixture');
});
test('updates need a valid fixed component, semantic version and explicit confirmation',async t=>{
 const f=await fixture(t);
 for(const body of [{component:'shell',version:'1.2.3',confirm:true},{component:'caveman',version:'$(id)',confirm:true},{component:'caveman',version:'1.2.3'}])assert.equal((await f.call('update',body)).status,400);
 for(const component of ['caveman','opencodex','codex']){
  assert.equal((await f.call('update',{component,version:'1.2.3',confirm:true})).status,202);
  await new Promise(r=>setTimeout(r,20));assert.equal((await f.call('status').then(r=>r.json())).job.status,'succeeded');assert.deepEqual(f.calls.filter(c=>c.a).at(-1),{a:'update',args:{component,version:'1.2.3'}});assert.equal(f.calls.at(-1)[0],'sync');
 }
});

test('batch updates validate the entire selection and launch one server operation',async t=>{
 const f=await fixture(t),updates=[{component:'opencodex',version:'2.100.2'},{component:'codex',version:'0.164.0'}];
 for(const body of [
  {updates:[],confirm:true},{updates:null,confirm:true},{updates:[updates[0],updates[0]],confirm:true},
  {updates:[...updates,...updates],confirm:true},{updates:[{component:'codex',version:123}],confirm:true},
  {updates:[{component:'shell',version:'1.2.3'}],confirm:true},{updates:[{...updates[0],command:'id'}],confirm:true},
  {updates,component:'caveman',version:'1.2.3',confirm:true},{updates},
 ])assert.equal((await f.call('update',body)).status,400);
 assert.deepEqual(f.calls,[]);
 assert.equal((await f.call('update',{updates,confirm:true})).status,202);
 await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(f.calls.filter(c=>c.a),[{a:'update',args:{updates}}]);assert.equal(f.calls.filter(Array.isArray).length,1);assert.equal(f.calls.at(-1)[0],'sync');
 assert.equal((await f.call('status').then(r=>r.json())).job.status,'succeeded');
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
  assert.equal((await f.call(route,{})).status,202);await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.calls.filter(c=>c.a&&c.a!=='status').at(-1),{a:action,args:{}});
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
 await remoteCommand(settings,'update',{component:'codex',version:'0.163.0'}, {platform:'linux',spawnFn:f.spawnFn});
 assert.deepEqual(JSON.parse(f.calls[1].input),{repo,action:'update',component:'codex',version:'0.163.0'});
 const updates=[{component:'caveman',version:'4.0.3'},{component:'opencodex',version:'2.100.2'}];
 await remoteCommand(settings,'update',{updates}, {platform:'linux',spawnFn:f.spawnFn});
 assert.deepEqual(JSON.parse(f.calls[2].input),{repo,action:'update',updates});
 assert.throws(()=>remoteCommand(settings,'update',{updates:[updates[0],updates[0]]},{platform:'linux',spawnFn:f.spawnFn}),/INVALID_UPDATE_SELECTION/);
 assert.equal(f.calls.length,3);
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

test('cache-only repair is reported as changed and a different expected Pod is refused before sync',async t=>{
 const f=await fixture(t);f.state.clientResult={ok:true,changed:true,catalogChanged:false,cacheChanged:true,cacheRepaired:true,configChanged:false,restartCodex:true,warnings:[]};
 assert.equal((await f.call('sync',{expectedUpstreamUrl:'http://other.test/v1'})).status,400);assert.deepEqual(f.calls,[]);
 assert.equal((await f.call('sync',{expectedUpstreamUrl:'http://server.test/v1/'})).status,202);
 await new Promise(r=>setTimeout(r,10));const status=await f.call('status').then(r=>r.json());
 assert.equal(status.capabilities.catalogSyncRepair,1);assert.match(status.controlInstance,/^[a-f0-9-]+$/);
 assert.equal(status.job.result.changed,true);assert.equal(status.job.result.catalogChanged,false);
 assert.equal(status.job.result.cacheRepaired,true);assert.equal(status.job.result.restartCodex,true);
});

test('explicit remote sync does not claim the initiating PC was already synchronized',async t=>{
 const calls=[],f=await fixture(t,{remoteClients:async(targets,ids,action,options)=>{
  calls.push({targets,ids,action,options});return {ok:true,action,results:[]};
 }});
 const saved=await f.call('remote-clients',{target:{host:'user@client.test',configPath:'/home/user/.codex/config.toml'}}).then(r=>r.json());
 await f.call('remote-client-action',{action:'sync',ids:[saved.remoteClients[0].id]});
 await new Promise(r=>setTimeout(r,10));
 assert.equal(calls.length,1);assert.equal(calls[0].action,'sync');
 assert.deepEqual(calls[0].options,{requireCacheRepair:true});
 assert.equal(f.calls.filter(Array.isArray).length,0,'explicit remote sync has not synchronized the local PC');
});

test('unchanged server refresh always repairs local cache and fans out with Pod and capability guards',async t=>{
 const remoteCalls=[],f=await fixture(t,{remoteClients:async(targets,ids,action,options)=>{
  assert.equal(f.calls.at(-1)[0],'sync','local follows the server before remote clients');
  remoteCalls.push({targets,ids,action,options});
  return {ok:true,action,results:targets.map(target=>({id:target.id,ok:true,result:{ok:true,cacheChanged:true,cacheRepaired:true,restartCodex:true}}))};
 }});
 f.state.serverResult={ok:true,changed:false};f.state.clientResult={ok:true,catalogChanged:false,cacheChanged:true,cacheRepaired:true,restartCodex:true,warnings:[]};
 await f.call('remote-clients',{target:{host:'user@client.test',configPath:'/home/user/.codex/config.toml'}});
 assert.equal((await f.call('refresh-server-catalog',{})).status,202);
 await new Promise(r=>setTimeout(r,10));const status=await f.call('status').then(r=>r.json());
 assert.deepEqual(f.calls[0],{a:'catalog',args:{}});assert.equal(f.calls[1][0],'sync');
 assert.equal(remoteCalls.length,1);assert.equal(remoteCalls[0].ids,'all');assert.equal(remoteCalls[0].action,'sync');
 assert.deepEqual(remoteCalls[0].options,{expectedUpstreamUrl:'http://server.test/v1',sourceControlInstance:status.controlInstance,requireCacheRepair:true});
 assert(!JSON.stringify(remoteCalls).includes(f.key));
 assert.equal(status.job.status,'succeeded');assert.equal(status.job.result.serverRefreshed,true);
 assert.equal(status.job.result.clientSync.local.cacheRepaired,true);assert.equal(status.job.result.clientSync.remote.results.length,1);
});

test('client failures preserve successful server result, keep other clients running and require only client retry',async t=>{
 let remoteCount=0;const f=await fixture(t,{remoteClients:async()=>{remoteCount++;return {ok:false,action:'sync',results:[
  {id:'online',ok:true,result:{ok:true,changed:false}},{id:'offline',ok:false,error:'REMOTE_SSH_FAILED'}]};}});
 await f.call('remote-clients',{target:{host:'user@client.test',configPath:'/home/user/.codex/config.toml'}});
 f.state.clientFails=true;f.state.serverResult={ok:true,unchanged:true,updates:[{component:'opencodex',version:'2.100.2'}]};
 assert.equal((await f.call('update',{component:'opencodex',version:'2.100.2',confirm:true})).status,202);
 await new Promise(r=>setTimeout(r,10));const status=await f.call('status').then(r=>r.json());
 assert.equal(status.job.status,'partial');assert.equal(status.job.error,undefined);assert.equal(status.job.result.serverApplied,true);
 assert.equal(status.job.result.unchanged,true);assert.equal(status.job.result.clientSync.local.error,'CLIENT_SYNC_FAILED');
 assert.equal(status.job.result.clientSync.remote.results[0].ok,true);assert.equal(remoteCount,1);
 assert(!JSON.stringify(status).includes('fixture secret'));assert.match(status.job.result.message,/서버 작업은 완료/);
});

test('server refresh failure does not modify or synchronize any client',async t=>{
 let remoteCount=0;const f=await fixture(t,{remoteClients:async()=>{remoteCount++;return {ok:true};}});
 f.state.serverFails=true;const before=fs.readFileSync(f.configPath);
 await f.call('refresh-server-catalog',{});await new Promise(r=>setTimeout(r,10));const status=await f.call('status').then(r=>r.json());
 assert.equal(status.job.status,'failed');assert.equal(status.job.result,undefined);
 assert.equal(f.calls.filter(Array.isArray).length,0);assert.equal(remoteCount,0);assert.deepEqual(fs.readFileSync(f.configPath),before);
});
