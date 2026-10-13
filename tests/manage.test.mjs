import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createManager,parseArgs,normalizeUrl,validateKey,choosePort,configureNewEnvironment,requirements,dependencyPlan,safeError,supportsPodman} from '../scripts/manage-lib.mjs';
import {setup,menu,terminalIO} from '../scripts/manage.mjs';

function fixture(t,{existing=false,...injections}={}) {
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'caveman-wizard-')),home=path.join(repo,'codex'),dir=path.join(home,'caveman-stack');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(repo,'data'));fs.mkdirSync(path.join(repo,'secrets'));
  const key='private-wizard-fixture-key-'.repeat(3),keyFile=path.join(repo,'secrets/gateway-key');fs.writeFileSync(keyFile,key);
  const configPath=path.join(dir,'native-bridge.json'),authFile=path.join(home,'auth.json');fs.writeFileSync(authFile,'existing-login-must-not-change');
  const original={upstreamUrl:'http://old.test:18787/v1',keyFile,port:18788,controlPort:18790,compression:true,management:{mode:'local',repo}};
  if(existing)fs.writeFileSync(configPath,JSON.stringify(original));
  const calls=[],state={};
  const run=async(command,args)=>{calls.push({command,args});if(state.failInstaller&&args.some(x=>x.endsWith('install-native-bridge-linux.mjs')))throw Error('secret-command-error');return '{}';};
  const manager=createManager({repo,codexHome:home,uid:1000,platform:'linux',env:{},nodePath:'/usr/bin/node',run,visible:run,portAvailable:async()=>true,
    fetchFn:async(url,opts)=>{
      if(state.reject)return new Response('',{status:401});
      if(url.endsWith('/healthz'))return Response.json({service:'caveman-native-bridge',controlVersion:1,upstreamUrl:'http://old.test:18787/v1'});
      if(url.endsWith('/catalog'))return Response.json({models:[{slug:'test',display_name:'Test',visibility:'list'}]});
      if(url.endsWith('/stack-info')){assert.equal(opts.headers['x-caveman-gateway-key'],state.key??key);return Response.json({capabilities:{compressionSwitch:true}});}
      return new Response('<meta name="control-token">');
    },client:async args=>{calls.push({client:args});if(state.failClient)throw Error('secret-client-error');return {ok:true,warnings:[],catalogChanged:false};},...injections});
  t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
  return {repo,home,dir,key,keyFile,configPath,authFile,original,calls,state,manager};
}

test('manager validates URL, credentials, action flags and scope without side effects',()=>{
  assert.equal(normalizeUrl('https://server.test:1234/'),'https://server.test:1234/v1');
  for(const url of ['https://user:pass@server.test','file:///v1','https://server.test/v1?key=secret'])assert.throws(()=>normalizeUrl(url),/INVALID_URL/);
  assert.throws(()=>validateKey('secret\n'+'x'.repeat(50)),/INVALID_GATEWAY_KEY/);
  assert.throws(()=>parseArgs(['--repair','--status']),/USAGE/);
  assert.throws(()=>parseArgs(['--system','--user']),/USAGE/);
  assert.equal(parseArgs(['--status','--codex-home','./test','--user']).scope,'user');
  assert.equal(safeError(Error('private-oauth-token-here')),'OPERATION_FAILED');
});
test('new client configuration writes no key to args or results and preserves login',async t=>{
  const f=fixture(t);const result=await f.manager.configureConnection({upstreamUrl:'http://new.test:18787',key:f.key,local:false});
  const c=JSON.parse(fs.readFileSync(f.configPath));assert.equal(c.management,null);assert.equal(fs.readFileSync(c.keyFile,'utf8'),f.key);
  assert.equal(fs.readFileSync(f.authFile,'utf8'),'existing-login-must-not-change');
  assert(!JSON.stringify({result,calls:f.calls,status:await f.manager.status()}).includes(f.key));
  assert(f.calls.some(x=>x.args?.includes('--user')));assert(f.calls.some(x=>x.client?.includes('--bridge-url')));
  if(process.platform!=='win32')assert.equal(fs.statSync(c.keyFile).mode&0o777,0o600);
});
test('rejected gateway and failed bridge install preserve existing configuration and key',async t=>{
  const f=fixture(t,{existing:true}),before=fs.readFileSync(f.configPath),newKey='new-private-wizard-key-'.repeat(3);
  f.state.reject=true;await assert.rejects(f.manager.configureConnection({upstreamUrl:'http://new.test',key:newKey}),/GATEWAY_KEY_REJECTED/);
  assert.deepEqual(fs.readFileSync(f.configPath),before);assert.equal(f.calls.length,0);
  f.state.reject=false;f.state.key=newKey;f.state.failInstaller=true;
  await assert.rejects(f.manager.configureConnection({upstreamUrl:'http://new.test',key:newKey}),/BRIDGE_INSTALL_FAILED/);
  assert.deepEqual(fs.readFileSync(f.configPath),before);assert.equal(fs.readFileSync(f.keyFile,'utf8'),f.key);
  assert.equal(fs.readdirSync(f.dir).filter(n=>n.startsWith('gateway-key-')).length,0);
  assert(!fs.existsSync(path.join(f.dir,'manager.lock')));
});
test('failed client reconfiguration restores an existing live connection, fresh install remains repairable',async t=>{
  const f=fixture(t,{existing:true}),before=fs.readFileSync(f.configPath);f.state.failClient=true;
  await assert.rejects(f.manager.configureConnection({upstreamUrl:'http://new.test',keyFile:f.keyFile}),/CLIENT_INSTALL_FAILED/);
  assert.deepEqual(fs.readFileSync(f.configPath),before);
  const fresh=fixture(t);fresh.state.failClient=true;
  await assert.rejects(fresh.manager.configureConnection({upstreamUrl:'http://new.test',keyFile:fresh.keyFile}),/CLIENT_INSTALL_FAILED/);
  assert(fs.existsSync(fresh.configPath));assert.equal(fs.readFileSync(fresh.authFile,'utf8'),'existing-login-must-not-change');
});
test('configuration lock refuses concurrent mutation and existing service scope cannot migrate silently',async t=>{
  const f=fixture(t,{existing:true});fs.mkdirSync(path.join(f.dir,'manager.lock'));
  await assert.rejects(f.manager.setCompression(false),/MANAGER_BUSY/);assert.equal(f.manager.settings().compression,true);
  fs.writeFileSync(path.join(f.dir,'native-bridge-install-linux.json'),JSON.stringify({unitPath:'/etc/systemd/system/caveman-native-bridge.service'}));
  assert.throws(()=>f.manager.serviceScope(),/SCOPE_MISMATCH/);
});

test('legacy bridge-only configuration acquires its existing default control port',async t=>{
  const f=fixture(t,{existing:true});
  const {controlPort,compression,management,...legacy}=f.original;
  fs.writeFileSync(f.configPath,JSON.stringify(legacy));
  await f.manager.configureConnection({upstreamUrl:legacy.upstreamUrl,keyFile:f.keyFile});
  assert.equal(f.manager.settings().controlPort,18786);
  assert.equal(f.manager.settings().port,legacy.port);
});
test('new server environment does not replace proxy, TLS or arbitrary settings',t=>{
  const f=fixture(t),file=path.join(f.repo,'.env');
  fs.writeFileSync(file,'# config\nBIND_ADDRESS=0.0.0.0\nPORT=18787\nADMIN_BIND_ADDRESS=\nADMIN_PORT=20100\nHTTPS_PROXY=https://private.example\nGATEWAY_TLS_CERT=/cert\n');
  configureNewEnvironment(file,{bindAddress:'127.0.0.1',port:20001,adminPort:20002});
  const text=fs.readFileSync(file,'utf8');assert.match(text,/PORT=20001/);assert.match(text,/ADMIN_BIND_ADDRESS=127.0.0.1/);assert.match(text,/HTTPS_PROXY=https:\/\/private.example/);assert.match(text,/GATEWAY_TLS_CERT=\/cert/);
});
test('port suggestions avoid conflicts and requirements distinguish client-only mode',async()=>{
  assert.equal(await choosePort(18788,[18789],async p=>p!==18788),18790);
  const commands=[];const run=async(c)=>{commands.push(c);return c==='python3'?'Python 3.11.2':c==='podman'?'podman version 4.9.3':'ok';};
  assert.equal((await requirements({server:false,run})).ok,true);assert(!commands.includes('podman'));
  assert.deepEqual((await requirements({server:true,run})).missing,[]);
  for(const version of ['4.9.3','podman version 5.6.1','3:4.9.3+ds1-1ubuntu0.1'])assert(supportsPodman(version));
  for(const version of ['4.9.2','4.3.1','(none)'])assert(!supportsPodman(version));
  assert.deepEqual((await dependencyPlan(['podman'],{exists:p=>p==='/usr/bin/apt-get',run:async()=> 'Candidate: 4.9.3+ds1-1ubuntu0.1'})).args,['install','-y','podman','uidmap']);
  await assert.rejects(dependencyPlan(['podman'],{exists:p=>p==='/usr/bin/apt-get',run:async()=> 'Candidate: 4.3.1'}),/PODMAN_REPOSITORY_TOO_OLD/);
});
test('server setup checks ownership before build and keeps existing TLS endpoint',async t=>{
  const f=fixture(t,{existing:true});fs.writeFileSync(path.join(f.repo,'.env'),'STACK_NAME=caveman-stack\nIMAGE=local/test\nBIND_ADDRESS=0.0.0.0\nPORT=18787\nADMIN_PORT=20100\nGATEWAY_TLS_CERT=/cert\nGATEWAY_TLS_KEY=/key\n');
  const commands=[];let blocked=true;
  const manager=createManager({repo:f.repo,codexHome:f.home,uid:1000,env:{},run:async(c,a)=>{
    commands.push([c,...a]);if(c==='python3'&&a[0]==='--version')return 'Python 3.11.2';if(c==='podman'&&a[0]==='--version')return 'podman version 5.0.0';
    if(a.includes('status'))return JSON.stringify({ok:true,installed:true,owned:false,adoptable:!blocked});return '';
  },visible:async(c,a)=>{commands.push([c,...a]);}});
  await assert.rejects(manager.installServer({adopt:true}),/SERVER_OWNERSHIP_FAILED/);
  assert(!commands.some(a=>a.includes('build')||a.includes('install')));
  blocked=false;const result=await manager.installServer({adopt:true});assert.equal(result.upstreamUrl,f.original.upstreamUrl);assert.equal(result.tls,true);
  assert(commands.some(a=>a.includes('--adopt-existing')));
});

test('client-only wizard does not build a server, asks masked key once, and supports skipping login',async()=>{
  const answers=['2','http://server.test:18787','2','18789','18791'],confirmations=[false,true,false];let hidden=0;
  const calls=[],lines=[];const key='wizard-secret-key-'.repeat(4);
  const io={write:x=>lines.push(x),ask:async()=>answers.shift(),confirm:async()=>confirmations.shift(),secret:async()=>{hidden++;return key;}};
  const manager={settings:()=>null,requirements:async server=>{assert.equal(server,false);return {ok:true,missing:[],systemd:true};},serviceScope:()=> 'user',defaults:async()=>({port:18789,controlPort:18791}),configureConnection:async c=>{calls.push(c);return {controlUrl:'http://127.0.0.1:18791/'};},doctor:async()=>({ok:false,warnings:['missing']}),codexHome:'/fresh/codex',repo:'/fresh/repo',isWsl:true};
  const result=await setup(io,manager);assert.equal(result.ok,true);assert.equal(hidden,1);assert.equal(calls[0].key,key);assert(!lines.join('\n').includes(key));assert.equal(calls[0].local,false);
});
test('full-server wizard discovers key/repo, registers startup, and never asks for a key',async()=>{
  const answers=['1','1','18787','20100','18788','18790'],confirmations=[false,true,true,false],calls=[];
  const io={write:()=>{},ask:async()=>answers.shift(),confirm:async()=>confirmations.shift(),secret:async()=>{throw Error('must not ask');}};
  const manager={settings:()=>null,requirements:async()=>({ok:true,missing:[],systemd:true}),serviceScope:()=> 'system',defaults:async()=>({port:18788,controlPort:18790}),installServer:async opts=>{calls.push(opts);return {upstreamUrl:'http://127.0.0.1:18787/v1',keyFile:'/fixture/secrets/gateway-key'};},configureConnection:async c=>{calls.push(c);return {controlUrl:'http://127.0.0.1:18790/'};},doctor:async()=>({ok:true,warnings:[]}),codexHome:'/nonexistent/codex',repo:'/nonexistent/repo',isWsl:false};
  await setup(io,manager);assert.equal(calls[0].bindAddress,'127.0.0.1');assert.equal(calls[1].keyFile,'/fixture/secrets/gateway-key');assert.equal(calls[1].local,true);
});
test('terminal secret input disables echo before showing prompt and restores terminal',async()=>{
  const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;input.isRaw=false;let display='';
  input.setRawMode=value=>{input.isRaw=value;};output.on('data',d=>{display+=d;if(d.toString().includes('Key:'))assert.equal(input.isRaw,true);});
  const pending=terminalIO({input,output}).secret('Key');input.write('sensitive-key\r');assert.equal(await pending,'sensitive-key');assert(!display.includes('sensitive-key'));assert.equal(input.isRaw,false);
});

test('Codex login and launch use the selected native runtime, home and working directory',async t=>{
  const calls=[];
  const f=fixture(t,{visible:async(command,args,options)=>calls.push({command,args,options})});
  await f.manager.login();await f.manager.startCodex(f.repo);
  assert.equal(calls[0].command,'/usr/bin/node');
  assert.deepEqual(calls[0].args.slice(1),['login','--device-auth']);
  assert.equal(calls[1].args.length,1);
  assert.equal(calls[1].options.cwd,f.repo);
  for(const call of calls)assert.equal(call.options.env.CODEX_HOME,f.home);
  assert.equal(fs.readFileSync(f.authFile,'utf8'),'existing-login-must-not-change');
});
