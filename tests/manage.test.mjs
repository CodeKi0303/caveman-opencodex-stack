import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createManager,normalizeUrl,parseManagerArgs,protectKey,safeError} from '../scripts/manage-lib.mjs';
import {createTerminalIO,runManagerMenu} from '../scripts/manage.mjs';

const model={slug:'test-model',display_name:'Test model'};
const firstKey='fixture-gateway-key-'.repeat(3),secondKey='fixture-new-gateway-key-'.repeat(3);
function fixture(t,{existing=true,platform='linux',webUiEnabled}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'caveman-manage-')),directory=path.join(home,'caveman-stack');
  fs.mkdirSync(directory);const keyFile=path.join(directory,'original-key'),configPath=path.join(directory,'native-bridge.json');
  fs.writeFileSync(keyFile,firstKey);
  const settings={upstreamUrl:'http://server.test:18787/v1',keyFile,port:18788,controlPort:18786,compression:true,timeoutMs:654321};
  if(existing)fs.writeFileSync(configPath,JSON.stringify(settings));
  const state={live:existing,calls:[],commands:[],requests:[],remotes:[]};
  const manager=createManager({codexHome:home,platform,webUiEnabled,secureFile:async()=>{},
    fetchFn:async(url,init={})=>{
      state.requests.push({url,init});
      if(url.endsWith('/healthz')){
        if(!state.live)throw Error('offline');
        const c=JSON.parse(fs.readFileSync(configPath));return Response.json({service:'caveman-native-bridge',ok:true,controlVersion:1,upstreamUrl:c.upstreamUrl,compression:c.compression,ignoredSecret:firstKey});
      }
      if(state.reject)return new Response('',{status:401});
      if(state.concurrent){const c=JSON.parse(fs.readFileSync(configPath));c.concurrent=true;fs.writeFileSync(configPath,JSON.stringify(c));state.concurrent=false;}
      return Response.json(url.endsWith('/stack-info')?{capabilities:{compressionSwitch:true}}:{models:[model]});
    },
    client:async args=>{state.calls.push(args);if(state.clientFails)throw Error(firstKey);return {ok:true,catalogChanged:false,restartCodex:true,warnings:[]};},
    run:async(command,args)=>{state.commands.push({command,args});if(state.commandFails)throw Error(firstKey);return '{}';},
    remote:async(c,action)=>{state.remotes.push({c,action});if(state.remoteFails)throw Error(firstKey);return action==='connection'?{ok:true,gatewayKey:secondKey}:{ok:true,running:true};}});
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  return {manager,home,directory,keyFile,configPath,settings,state};
}
test('CLI parsing/status are read-only and never expose keys or response fields',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.configPath);const value=await f.manager.status();
  assert(value.gateway.ok&&value.bridge.ok);assert(!JSON.stringify(value).includes(firstKey));assert(!JSON.stringify(value).includes('ignoredSecret'));
  assert.deepEqual(fs.readFileSync(f.configPath),before);assert.deepEqual(f.state.calls,[]);assert.deepEqual(f.state.commands,[]);
  assert.equal(value.mode,'headless');assert.equal(value.webUiEnabled,false);assert(!('controlUrl' in value));
  assert.equal(parseManagerArgs(['--status','--codex-home',f.home]).codexHome,f.home);
  assert.equal(parseManagerArgs(['--headless']).webUiEnabled,false);assert.equal(parseManagerArgs(['--with-web-ui']).webUiEnabled,true);
  for(const args of [['--key',firstKey],['--system','--user'],['--codex-home'],['--headless','--with-web-ui'],['--with-web-ui','--headless'],['--headless','--headless']])assert.throws(()=>parseManagerArgs(args),/USAGE/);
  assert.equal(normalizeUrl('https://pod.test:443'),'https://pod.test/v1');
  for(const url of ['https://user:key@pod.test/v1','https://pod.test/v1?secret=1','https://pod.test/other','file:///v1'])assert.throws(()=>normalizeUrl(url));
});
test('fresh connection validates before writing, saves key privately, and leaves Codex untouched until installation',async t=>{
  const f=fixture(t,{existing:false});
  f.state.reject=true;await assert.rejects(f.manager.saveConnection({upstreamUrl:'https://pod.test',key:secondKey}),/GATEWAY_KEY_REJECTED/);
  assert(!fs.existsSync(f.configPath));assert.deepEqual(fs.readdirSync(f.directory),['original-key']);
  f.state.reject=false;const result=await f.manager.saveConnection({upstreamUrl:'https://pod.test',key:secondKey,compression:false});
  assert(result.installRequired);assert(!result.appliedToClient);assert.deepEqual(f.state.calls,[]);
  const saved=JSON.parse(fs.readFileSync(f.configPath));assert.equal(saved.upstreamUrl,'https://pod.test/v1');assert.equal(fs.readFileSync(saved.keyFile,'utf8'),secondKey);
  if(process.platform!=='win32')assert.equal(fs.statSync(saved.keyFile).mode&0o777,0o600);
  assert(!fs.existsSync(path.join(f.home,'config.toml')));
});
test('live connection reconfigure preserves extra fields and rolls back key/config when client update fails',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.configPath);
  f.state.clientFails=true;await assert.rejects(f.manager.saveConnection({upstreamUrl:'https://pod.test',key:secondKey}));
  assert.deepEqual(fs.readFileSync(f.configPath),before);assert.equal(fs.readdirSync(f.directory).filter(v=>v.startsWith('gateway-key-')).length,0);
  f.state.clientFails=false;await f.manager.saveConnection({upstreamUrl:'https://pod.test',key:secondKey});
  const saved=JSON.parse(fs.readFileSync(f.configPath));assert.equal(saved.timeoutMs,654321);assert(f.state.calls.at(-1).includes('--bridge-url'));assert(!f.state.calls.at(-1).includes(secondKey));
});
test('lost gateway key can be replaced manually or imported over existing SSH without displaying it',async t=>{
  for(const imported of [false,true]){
    const f=fixture(t);fs.unlinkSync(f.keyFile);const ssh=path.join(f.directory,'ssh-key');fs.writeFileSync(ssh,'synthetic SSH fixture');
    const result=await f.manager.saveConnection({upstreamUrl:f.settings.upstreamUrl,...(imported?{importKey:true}:{key:secondKey}),management:{host:'root@server.test',keyFile:ssh,repo:'/home/stack'}});
    assert(result.ok);assert.equal(fs.readFileSync(f.manager.settings().keyFile,'utf8'),secondKey);assert(!JSON.stringify(result).includes(secondKey));
    assert.equal(f.state.remotes.length,imported?1:0);if(imported)assert.equal(f.state.remotes[0].action,'connection');
  }
});
test('concurrent config changes and existing-port changes do not overwrite the active installation',async t=>{
  const f=fixture(t);f.state.concurrent=true;
  await assert.rejects(f.manager.saveConnection({upstreamUrl:f.settings.upstreamUrl,key:secondKey}),/CONCURRENT_EDIT/);
  assert.equal(f.manager.settings().concurrent,true);assert.equal(fs.readdirSync(f.directory).filter(v=>v.startsWith('gateway-key-')).length,0);
  await assert.rejects(f.manager.saveConnection({upstreamUrl:f.settings.upstreamUrl,port:19000}),/PORT_CHANGE_REQUIRES_REINSTALL/);
});
test('SSH configuration cannot send credentials to a host different from the selected gateway',async t=>{
  const f=fixture(t),ssh=path.join(f.directory,'ssh');fs.writeFileSync(ssh,'test');
  await assert.rejects(f.manager.saveConnection({upstreamUrl:f.settings.upstreamUrl,management:{host:'root@another.test',keyFile:ssh,repo:'/home/stack'},importKey:true}),/SSH_TARGET_MISMATCH/);
  assert.equal(f.state.remotes.length,0);
  await assert.rejects(f.manager.remoteOperation('connection'),/INVALID_ACTION/);
});
test('Linux installs without a web service by default, web UI is opt-in, and Windows keeps its previous default',async t=>{
  for(const options of [{platform:'linux'},{platform:'linux',webUiEnabled:true},{platform:'win32'},{platform:'win32',webUiEnabled:false}]){
    const f=fixture(t,options),before=fs.readFileSync(f.configPath);const result=await f.manager.installLocal();assert(result.ok);
    const web=options.webUiEnabled??options.platform==='win32';assert.equal(result.webUiEnabled,web);assert.equal(f.manager.webUiEnabled,web);assert.equal(result.mode,web?'web-ui':'headless');
    assert.equal('controlUrl' in result,web);assert.equal(f.state.commands.length,web?2:1);assert(f.state.commands[0].args.some(v=>v.includes('install-native-bridge')));
    if(web)assert(f.state.commands[1].args.some(v=>v.includes('install-control-panel')));
    else assert(!JSON.stringify(f.state.commands).includes('control-panel'));
    assert.deepEqual(fs.readFileSync(f.configPath),before); // Mode choices do not remove existing web settings or services.
    const status=await f.manager.status();assert.equal(status.webUiEnabled,web);assert.equal('controlUrl' in status,web);
    assert(f.state.calls[0].includes('configure'));assert(f.state.calls[0].includes('openai'));assert(!JSON.stringify(f.state.commands).includes(firstKey));
    assert(!JSON.stringify(f.state.calls).includes(firstKey));
    await f.manager.doctor();assert(f.state.calls.at(-1).includes('--bridge-url'));assert(f.state.calls.at(-1).includes('openai'));
  }
});
test('failed local commands report partial progress accurately',async t=>{
  const f=fixture(t);f.state.clientFails=true;await assert.rejects(f.manager.installLocal(),/BRIDGE_INSTALLED_CLIENT_FAILED/);assert.equal(f.state.commands.length,1);
  f.state.clientFails=false;f.state.commandFails=true;await assert.rejects(f.manager.installLocal());
});
test('system/user scope is recovered from the existing installation; WSL has separate default ports',async t=>{
  const f=fixture(t,{webUiEnabled:true});fs.writeFileSync(path.join(f.directory,'native-bridge-install-linux.json'),JSON.stringify({unitPath:'/etc/systemd/system/caveman-native-bridge.service'}));
  assert.equal(f.manager.serviceScope(),'system');await f.manager.installLocal();assert(f.state.commands[0].args.includes('--system'));assert(f.state.commands[1].args.includes('--system'));
  assert.equal(createManager({codexHome:f.home,env:{WSL_DISTRO_NAME:'Ubuntu'}}).defaults.port,18789);
});
test('masked key prompt emits no plaintext, handles backspace, and restores terminal on completion/cancellation',async()=>{
  for(const cancel of [false,true]){
    const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};output.isTTY=true;
    let printed='';output.on('data',chunk=>{printed+=chunk;if(chunk.toString().includes('API key:')){assert.equal(input.isRaw,true);assert.equal(input.listenerCount('data'),1);}});const io=createTerminalIO({input,output});
    const pending=io.secret('API key');input.write(Buffer.from('fixture-secretx\x7f'+(cancel?'\x03':'\r')));
    if(cancel)await assert.rejects(pending,/CANCELLED/);else assert.equal(await pending,'fixture-secret');
    assert(!printed.includes('fixture-secret'));assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);input.destroy();output.destroy();
  }
});
test('non-TTY secret input is rejected; unexpected error strings cannot reveal secrets',async()=>{
  await assert.rejects(createTerminalIO({input:new PassThrough(),output:new PassThrough()}).secret('key'),/TTY_REQUIRED/);
  assert.equal(safeError(Error(firstKey)),'OPERATION_FAILED');assert.equal(safeError(Error('THISISANUPPERCASESECRETVALUE')),'OPERATION_FAILED');
});
test('menu exit and cancelled server restart perform no state changes',async()=>{
  const asked=['9','0'],messages=[];let called=false;
  const io={write:value=>messages.push(value),ask:async()=>asked.shift(),confirm:async()=>false};
  await runManagerMenu({settings:()=>({management:{host:'root@server.test',repo:'/home/stack'}}),remoteOperation:async()=>{called=true;}},io);
  assert(!called);assert(!messages.join('\n').includes(firstKey));
});
test('headless setup asks no web port and server catalog refresh is available from the terminal menu',async()=>{
  const answers=['1','https://server.test','2','18788','14','0'],confirmations=[false,true,false,true],questions=[],messages=[],actions=[];let connection;
  const manager={webUiEnabled:false,defaults:{port:18788,controlPort:18786},settings:()=>null,
    saveConnection:async value=>{connection=value;return {ok:true,models:1,installRequired:true};},remoteOperation:async action=>{actions.push(action);return {ok:true};}};
  const io={write:value=>messages.push(value),ask:async question=>{questions.push(question);return answers.shift();},secret:async()=>secondKey,confirm:async()=>confirmations.shift()};
  await runManagerMenu(manager,io);
  assert.equal(connection.controlPort,18786);assert(!questions.some(value=>value.includes('제어 페이지 포트')));assert(!messages.join('\n').includes(secondKey));assert.deepEqual(actions,['catalog']);
});
test('Windows keys have an explicit owner-only file ACL', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);await protectKey(f.keyFile);
  // icacls reports inheritance with (I). The key must have an explicit grant,
  // and no inherited ACE after protectKey. The synthetic contents are not read.
  const {execFileSync}=await import('node:child_process');const acl=execFileSync('icacls.exe',[f.keyFile],{encoding:'utf8',windowsHide:true});
  assert(!acl.includes('(I)'));assert(acl.includes('(F)'));
});
