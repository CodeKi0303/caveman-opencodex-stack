import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once,EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {validateRemoteTarget,validateRemoteTargets,buildRemoteClientRequest,remoteClientCommand,runRemoteClients} from '../scripts/remote-clients.mjs';
import {runRemoteClientWorker,sanitizeRemoteResult} from '../scripts/remote-client-worker.mjs';

const secret='private-gateway-test-'.repeat(3);
const settings={upstreamUrl:'http://pod.test:18787/v1',key:secret,compression:false,clientAuthMode:'server'};
const target={id:'pc-one',label:'WSL 작업 PC',host:'user@pc-one',configPath:'/home/user/.codex/caveman-stack/native-bridge.json'};

function directory(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'caveman-remote-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  return home;
}

function fakeProcess(run) {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  let input='';child.stdin.on('data',chunk=>input+=chunk);
  child.stdin.on('finish',()=>queueMicrotask(()=>run(child,input)));
  child.kill=()=>{child.emit('close',null);return true;};
  return child;
}

test('SSH targets normalize config.toml and support a host alias, agent, key, Windows and custom SSH port',t=>{
  const home=directory(t),keyFile=path.join(home,'key');fs.writeFileSync(keyFile,'fixture');
  const normalized=validateRemoteTarget({...target,keyFile,port:2222,configPath:'/home/user/코덱스 config/config.toml'});
  assert.equal(normalized.configPath,'/home/user/코덱스 config/caveman-stack/native-bridge.json');assert.equal(normalized.port,2222);
  assert.equal(validateRemoteTarget({...target,platform:'windows',configPath:'C:\\Users\\Code Ki\\.codex\\config.toml'}).configPath,'C:\\Users\\Code Ki\\.codex\\caveman-stack\\native-bridge.json');
  assert.equal(validateRemoteTarget({...target,id:undefined}).id,validateRemoteTarget({...target,id:undefined}).id);
  assert(!('keyFile' in validateRemoteTarget(target)));
  const plan=buildRemoteClientRequest({...target,keyFile,port:2222},'apply',settings);
  assert(plan.args.includes(keyFile));assert(plan.args.includes('2222'));assert(plan.args.includes('StrictHostKeyChecking=yes'));
  assert(plan.args.includes('BatchMode=yes'));assert(!plan.args.join(' ').includes(secret));assert(!plan.args.join(' ').includes(target.configPath));
  assert.equal(JSON.parse(plan.stdin).request.settings.key,secret);
  assert.deepEqual(JSON.parse(plan.stdin).request.settings,settings);
});

test('SSH validators reject option, newline and relative path inputs and duplicate PCs',()=>{
  for(const patch of [{host:'-oProxyCommand=bad'},{host:'pc;whoami'},{host:'pc\nwhoami'},{port:0},{platform:'mac'},
    {configPath:'relative/native-bridge.json'},{configPath:'/tmp/arbitrary.json'},{configPath:'/tmp/a\nnative-bridge.json'},
    {nodePath:'node;echo bad'},{id:'../x'},{keyFile:'relative-key'},
    {platform:'windows',configPath:'\\\\server\\share\\native-bridge.json'}])assert.throws(()=>validateRemoteTarget({...target,...patch}));
  assert.throws(()=>validateRemoteTargets([target,{...target,id:'other'}]),/DUPLICATE_REMOTE_TARGET/);
  assert.throws(()=>validateRemoteTargets(Array(51).fill(target)),/INVALID_REMOTE_TARGETS/);
  assert.throws(()=>buildRemoteClientRequest(target,'apply',{...settings,upstreamUrl:'https://user:secret@host/v1'}),/INVALID_REMOTE_SETTINGS/);
  assert.throws(()=>buildRemoteClientRequest(target,'apply',{...settings,key:secret+'\n'}),/INVALID_REMOTE_KEY/);
});

test('SSH stdout is reduced to the fixed schema and stderr never becomes a user error',async()=>{
  const result=await remoteClientCommand(target,'status',undefined,{spawnFn:(command,args,opts)=>{
    assert.equal(command,'ssh');assert.equal(opts.windowsHide,true);assert(!args.join(' ').includes(secret));
    return fakeProcess((child,input)=>{assert.equal(JSON.parse(input).request.action,'status');child.stderr.write(secret);child.stdout.end(JSON.stringify({ok:true,upstreamUrl:'http://pod.test/v1',bridge:{ok:true,key:secret},catalog:{count:3,totalCount:9,secret},raw:secret}));child.emit('close',0);});
  }});
  assert.equal(result.bridge.ok,true);assert.equal(result.catalog.count,3);assert(!JSON.stringify(result).includes(secret));
  const failure=await remoteClientCommand(target,'status',undefined,{spawnFn:()=>fakeProcess(child=>{child.stdout.end(JSON.stringify({ok:false,error:secret}));child.emit('close',1);})});
  assert.deepEqual(failure,{ok:false,error:'REMOTE_CLIENT_FAILED'});
  await assert.rejects(remoteClientCommand(target,'status',undefined,{spawnFn:()=>fakeProcess(child=>{child.stderr.write(secret);child.emit('close',255);})}),/REMOTE_SSH_FAILED/);
  assert(!JSON.stringify(sanitizeRemoteResult('doctor',{ok:true,auth:{token:secret},warnings:['normal_warning',secret],mcp:{ok:true,secret}})).includes(secret));
});

test('batch operations continue after an offline PC and preserve selection and result ordering',async()=>{
  const targets=[target,{...target,id:'pc-two',host:'pc-two'},{...target,id:'pc-three',host:'pc-three'}],calls=[];
  const result=await runRemoteClients(targets,'all','apply',settings,{command:async(t,a,s)=>{
    calls.push(t.id);assert.equal(a,'apply');assert.equal(s.key,secret);if(t.id==='pc-two')throw Error('REMOTE_SSH_FAILED');
    return {ok:true,applied:true};
  }});
  assert.equal(result.ok,false);assert.equal(result.results.length,3);assert.deepEqual(result.results.map(r=>r.id),targets.map(t=>t.id));
  assert.equal(result.results[1].error,'REMOTE_SSH_FAILED');assert.equal(result.results[2].ok,true);assert.equal(calls.length,3);
  await assert.rejects(runRemoteClients(targets,['missing'],'sync'),/INVALID_REMOTE_SELECTION/);
  await assert.rejects(runRemoteClients(targets,[],'status'),/INVALID_REMOTE_SELECTION/);
});

async function controlFixture(t,{capability=true}={}) {
  const home=directory(t),configPath=path.join(home,'native-bridge.json'),authPath=path.join(home,'auth.json');
  fs.writeFileSync(authPath,'UNCHANGED_LOCAL_AUTH');
  const token='a'.repeat(64),state={bodies:[],job:null,busy:false,management:{host:'different-management-host'},bridgePort:18788};
  const status=()=>({ok:true,capabilities:capability?{remoteClientManagement:1}:{},settings:{upstreamUrl:state.upstreamUrl??'http://old.test/v1',compression:state.compression??true,clientAuthMode:state.clientAuthMode??'forward',bridgeUrl:`http://127.0.0.1:${state.bridgePort}/v1`,management:state.management,key:secret},
    bridge:{ok:true,hotReload:true},gateway:{ok:true},catalog:{count:3,totalCount:9,hiddenCount:6},job:state.job,busy:state.busy});
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/'){res.end(`<meta name="control-token" content="${token}">`);return;}
    assert.equal(req.headers['x-control-token'],token);
    if(req.url==='/api/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify(status()));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));state.bodies.push({route:req.url,body});
    if(req.url==='/api/settings'){state.upstreamUrl=body.upstreamUrl;state.compression=body.compression;state.clientAuthMode=body.clientAuthMode;res.end(JSON.stringify({ok:true}));return;}
    state.job={id:'job-one',status:state.failDoctor?'failed':'succeeded',...(state.failDoctor?{error:'DOCTOR_FAILED'}:{}),result:{ok:!state.failDoctor,changed:false,restartCodex:false,warnings:state.failDoctor?['openai_bridge_url_mismatch']:[],mcp:{ok:true,recoveryAvailable:true},bridge:{ok:true},catalog:{ok:true,referenceMatches:true},auth:{token:secret}}};
    res.statusCode=202;res.end(JSON.stringify({ok:true,job:state.job}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  fs.writeFileSync(configPath,JSON.stringify({port:18788,controlPort:server.address().port,upstreamUrl:'http://old.test/v1'}));
  return {state,home,configPath,authPath};
}

test('worker calls the remote control page and applies only shared Pod settings without reading authentication',async t=>{
  const f=await controlFixture(t),before=fs.readFileSync(f.authPath);
  const initial=await runRemoteClientWorker({action:'status',configPath:f.configPath});
  assert.equal(initial.canApply,true);assert.equal(initial.catalog.count,3);assert(!JSON.stringify(initial).includes(secret));
  const applied=await runRemoteClientWorker({action:'apply',configPath:f.configPath,settings});
  assert.equal(applied.applied,true);assert.equal(applied.restartCodex,true);
  assert.deepEqual(f.state.bodies,[{route:'/api/settings',body:settings}]);assert.equal(f.state.management.host,'different-management-host');
  assert.deepEqual(fs.readFileSync(f.authPath),before);
});

test('old panels allow status/sync/doctor and reject apply until client auth support is installed',async t=>{
  const f=await controlFixture(t,{capability:false});
  assert.equal((await runRemoteClientWorker({action:'status',configPath:f.configPath})).canApply,false);
  await assert.rejects(runRemoteClientWorker({action:'apply',configPath:f.configPath,settings}),/REMOTE_CONTROL_UPGRADE_REQUIRED/);
  const sync=await runRemoteClientWorker({action:'sync',configPath:f.configPath});assert.equal(sync.ok,true);assert.equal(sync.changed,false);
  f.state.failDoctor=true;
  const doctor=await runRemoteClientWorker({action:'doctor',configPath:f.configPath});
  assert.equal(doctor.ok,false);assert.equal(doctor.error,'DOCTOR_FAILED');assert.deepEqual(doctor.diagnostic.warnings,['openai_bridge_url_mismatch']);assert(!JSON.stringify(doctor).includes(secret));
});

test('worker refuses a different control service or an active operation before writing',async t=>{
  const f=await controlFixture(t);f.state.bridgePort=18789;
  await assert.rejects(runRemoteClientWorker({action:'apply',configPath:f.configPath,settings}),/REMOTE_CONTROL_CONFIG_MISMATCH/);
  assert.deepEqual(f.state.bodies,[]);f.state.bridgePort=18788;f.state.busy=true;
  await assert.rejects(runRemoteClientWorker({action:'apply',configPath:f.configPath,settings}),/REMOTE_CLIENT_BUSY/);assert.deepEqual(f.state.bodies,[]);
});

test('Windows SSH bootstrap launches Node with source and secret only on stdin', {skip:process.platform!=='win32'},async t=>{
  const f=await controlFixture(t);
  const remote={...target,platform:'windows',configPath:f.configPath,nodePath:process.execPath};
  const result=await remoteClientCommand(remote,'apply',settings,{spawnFn:(command,args,options)=>{
    assert.equal(command,'ssh');const remoteCommand=args.at(-1);assert(remoteCommand.length<8191);assert(!remoteCommand.includes(secret));
    const encoded=remoteCommand.split(' ').at(-1);
    return spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],options);
  }});
  assert.equal(result.ok,true);assert.equal(result.applied,true);assert.equal(f.state.bodies[0].body.key,secret);
});

test('Linux SSH bootstrap discovers Node and pipes the worker without command-line secrets', {skip:process.platform!=='linux'},async t=>{
  const f=await controlFixture(t),manifest=path.join(f.home,'native-bridge-install-linux.json');
  fs.writeFileSync(manifest,JSON.stringify({managedBy:'caveman-opencodex-stack',configPath:f.configPath,nodePath:process.execPath}));
  const result=await remoteClientCommand({...target,configPath:f.configPath},'apply',settings,{spawnFn:(command,args,options)=>{
    assert.equal(command,'ssh');const encoded=/b64decode\('([^']+)'\)/.exec(args.at(-1))[1];
    return spawn('python3',['-c',Buffer.from(encoded,'base64').toString('utf8')],options);
  }});
  assert.equal(result.ok,true);assert.equal(result.applied,true);assert.equal(f.state.bodies[0].body.key,secret);
});
