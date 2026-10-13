import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runClient, validateCatalog} from './client-lib.mjs';
import {remoteCommand} from './control-panel.mjs';

const execute = promisify(execFile);
export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = file => {try{return fs.readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw Error('CONFIG_UNREADABLE');}};
const equal = (a,b) => a===null ? b===null : b!==null&&a.equals(b);
function atomic(file,value) {
  const temporary=file+'.tmp-'+randomUUID();
  try{fs.writeFileSync(temporary,value,{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
export function normalizeUrl(value) {
  let url;try{url=new URL(value);}catch{throw Error('INVALID_URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['/','/v1','/v1/'].includes(url.pathname))throw Error('INVALID_URL');
  url.pathname='/v1';return url.href;
}
export function validateKey(value) {
  if(typeof value!=='string')throw Error('INVALID_GATEWAY_KEY');
  const key=value.trim();if(key.length<32||key.length>4096||/[\x00-\x20\x7f]/.test(key))throw Error('INVALID_GATEWAY_KEY');return key;
}
export function validatePort(value) {const n=Number(value);if(!Number.isInteger(n)||n<1024||n>65535)throw Error('INVALID_PORT');return n;}
export function parseArgs(argv,{env=process.env,home=os.homedir()}={}) {
  const options={};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(['--help','-h','--status','--setup','--repair'].includes(arg)){const k=arg==='-h'?'help':arg.slice(2);if(options[k])throw Error('USAGE');options[k]=true;}
    else if(['--system','--user'].includes(arg)){if(options.scope)throw Error('USAGE');options.scope=arg.slice(2);}
    else if(arg==='--codex-home'){if(options.codexHome||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('USAGE');options.codexHome=argv[++i];}
    else throw Error('USAGE');
  }
  if([options.status,options.setup,options.repair].filter(Boolean).length>1)throw Error('USAGE');
  return {...options,codexHome:path.resolve(options.codexHome||env.CODEX_HOME||path.join(home,'.codex'))};
}
export async function capture(command,args,{cwd=repository,env=process.env,timeout=30000}={}) {
  try{return (await execute(command,args,{cwd,env,timeout,encoding:'utf8',maxBuffer:2*1024*1024,windowsHide:true})).stdout;}
  catch{throw Error('COMMAND_FAILED');}
}
export function interactive(command,args,{cwd=repository,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:'inherit',windowsHide:true});
    child.once('error',()=>reject(Error('COMMAND_FAILED')));
    child.once('exit',(code,signal)=>code===0?resolve():reject(Error(signal?'CANCELLED':'COMMAND_FAILED')));
  });
}
export async function availablePort(port) {
  return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen({host:'127.0.0.1',port},()=>s.close(()=>resolve(true)));});
}
export async function choosePort(start,excluded=[],available=availablePort) {
  for(let port=validatePort(start);port<=Math.min(start+100,65535);port++)if(!excluded.includes(port)&&await available(port))return port;
  throw Error('NO_FREE_PORT');
}
function readConfig(file) {
  const raw=bytes(file);if(!raw)return null;
  try{const c=JSON.parse(raw);normalizeUrl(c.upstreamUrl);validatePort(c.port);validatePort(c.controlPort??18786);if(c.port===(c.controlPort??18786)||!path.isAbsolute(c.keyFile))throw Error();return c;}
  catch{throw Error('CONFIG_INVALID');}
}
async function fetchJson(fetchFn,url,headers={}) {
  let response;
  try{response=await fetchFn(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Error('GATEWAY_UNAVAILABLE');}
  if(!response.ok)throw Error(response.status===401||response.status===403?'GATEWAY_KEY_REJECTED':'GATEWAY_UNAVAILABLE');
  let size=0;const chunks=[];
  try{for await(const chunk of response.body){size+=chunk.length;if(size>16*1024*1024)throw Error();chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString());}
  catch{throw Error('INVALID_SERVER_RESPONSE');}
}
export function readEnvironment(file) {
  const text=bytes(file)?.toString();if(text===undefined)return null;
  const result={};for(const line of text.split(/\r?\n/)){if(!line.trim()||line.trimStart().startsWith('#'))continue;const at=line.indexOf('=');if(at<1)throw Error('CONFIG_INVALID');result[line.slice(0,at).trim()]=line.slice(at+1).trim();}return result;
}
export function configureNewEnvironment(file,{bindAddress='127.0.0.1',port=18787,adminPort=20100}={}) {
  if(!['127.0.0.1','0.0.0.0'].includes(bindAddress))throw Error('INVALID_BIND');
  validatePort(port);validatePort(adminPort);if(port===adminPort)throw Error('INVALID_PORT');
  const values={BIND_ADDRESS:bindAddress,PORT:String(port),ADMIN_BIND_ADDRESS:'127.0.0.1',ADMIN_PORT:String(adminPort)};
  const raw=bytes(file);if(!raw)throw Error('CONFIG_UNREADABLE');
  const output=raw.toString().split(/\r?\n/).map(line=>{const at=line.indexOf('=');const key=line.slice(0,at).trim();return at>0&&Object.hasOwn(values,key)?key+'='+values[key]:line;}).join('\n');
  atomic(file,output);
}
export function supportsPodman(version) {
  const match=/(?:^|\s)(?:\d+:)?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if(!match)return false;
  const [major,minor,patch]=match.slice(1).map(Number);
  return major>4||major===4&&(minor>9||minor===9&&patch>=3);
}
export async function requirements({server=false,run=capture,scope='user'}={}) {
  const missing=[];
  for(const [name,args,check] of [
    ['python3',['--version'],v=>{const m=/Python (\d+)\.(\d+)/.exec(v);return m&&(Number(m[1])>3||Number(m[1])===3&&Number(m[2])>=11);}],
    ['git',['--version'],()=>true],
    ...(server?[['podman',['--version'],supportsPodman],['slirp4netns',['--version'],()=>true]]:[])
  ])try{if(!check(await run(name,args)))missing.push(name);}catch{missing.push(name);}
  let systemd=true;try{await run('systemctl',[...(scope==='user'?['--user']:[]),'show','--property=Version','--value']);}catch{systemd=false;}
  return {ok:missing.length===0&&systemd,missing,systemd};
}
export async function dependencyPlan(missing,{run=capture,exists=fs.existsSync}={}) {
  const allowed=new Set(['python3','git','podman','slirp4netns']);if(missing.some(x=>!allowed.has(x)))throw Error('UNSUPPORTED_DEPENDENCY');
  if(exists('/usr/bin/apt-get')) {
    if(missing.includes('podman')) {
      const text=await run('apt-cache',['policy','podman']);const m=/Candidate:\s*([^\s]+)/.exec(text);
      if(!m||!supportsPodman(m[1]))throw Error('PODMAN_REPOSITORY_TOO_OLD');
    }
    return {command:'apt-get',args:['install','-y',...missing,...(missing.includes('podman')?['uidmap']:[])]};
  }
  if(exists('/usr/bin/dnf'))return {command:'dnf',args:['install','-y',...missing]};
  throw Error('PACKAGE_MANAGER_UNSUPPORTED');
}

export function createManager({codexHome,scope,repo=repository,nodePath=process.execPath,uid=process.getuid?.()??1000,
  env=process.env,platform=process.platform,run=capture,visible=interactive,client=runClient,fetchFn=fetch,remote=remoteCommand,portAvailable=availablePort}={}) {
  const home=path.resolve(codexHome||env.CODEX_HOME||path.join(os.homedir(),'.codex'));
  const directory=path.join(home,'caveman-stack'),configPath=path.join(directory,'native-bridge.json');
  const settings=()=>readConfig(configPath);
  const required=()=>{const c=settings();if(!c)throw Error('NOT_CONFIGURED');return c;};
  const keyOf=c=>{try{return validateKey(fs.readFileSync(c.keyFile,'utf8'));}catch{throw Error('KEY_FILE_UNREADABLE');}};
  const script=name=>path.join(repo,'scripts',name);
  function serviceScope() {
    let installed;
    try{const m=JSON.parse(fs.readFileSync(path.join(directory,'native-bridge-install-linux.json')));installed=m.unitPath.startsWith('/etc/systemd/system/')?'system':'user';}catch{}
    if(scope&&installed&&scope!==installed)throw Error('SCOPE_MISMATCH');
    const selected=scope||installed||(uid===0?'system':'user');
    if(selected==='system'&&uid!==0||selected==='user'&&uid===0)throw Error('SCOPE_MISMATCH');return selected;
  }
  const command=(name,args=[],options={})=>run(name,args,{cwd:repo,...options});
  const show=(name,args=[],options={})=>visible(name,args,{cwd:repo,...options});
  function localManagement(c) {if(c.management?.mode!=='local'||fs.realpathSync(c.management.repo)!==fs.realpathSync(repo))throw Error('LOCAL_SERVER_REQUIRED');}
  async function gateway(c,key=keyOf(c)) {
    const headers={'x-caveman-gateway-key':key};
    const info=await fetchJson(fetchFn,c.upstreamUrl+'/stack-info',headers);
    if(info.capabilities?.compressionSwitch!==true)throw Error('SERVER_UPGRADE_REQUIRED');
    const catalog=validateCatalog(await fetchJson(fetchFn,c.upstreamUrl+'/catalog',headers));return {ok:true,models:catalog.models.length};
  }
  async function bridge(c) {
    try{const b=await fetchJson(fetchFn,`http://127.0.0.1:${c.port}/healthz`);return {ok:b.service==='caveman-native-bridge'&&b.controlVersion===1&&normalizeUrl(b.upstreamUrl??b.upstream)===c.upstreamUrl,compression:b.compression};}
    catch{return {ok:false};}
  }
  async function status() {
    const c=settings();const result={ok:true,configured:Boolean(c),codexHome:home,repo,scope:serviceScope(),wsl:Boolean(env.WSL_DISTRO_NAME)};
    if(!c)return result;
    let gatewayState;try{gatewayState=await gateway(c);}catch(e){gatewayState={ok:false,error:safeError(e)};}
    let web=false;try{const r=await fetchFn(`http://127.0.0.1:${c.controlPort??18786}/`,{redirect:'error',signal:AbortSignal.timeout(2000)});web=r.ok&&(await r.text()).includes('name="control-token"');}catch{}
    return {...result,upstreamUrl:c.upstreamUrl,compression:c.compression!==false,controlUrl:`http://127.0.0.1:${c.controlPort??18786}/`,bridge:await bridge(c),gateway:gatewayState,web,management:c.management?.mode==='local'?'local':c.management?'ssh':'none'};
  }
  async function locked(action) {
    fs.mkdirSync(directory,{recursive:true,mode:0o700});const lock=path.join(directory,'manager.lock');
    try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('MANAGER_BUSY');throw e;}
    try{fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,started:new Date().toISOString()}),{mode:0o600});return await action();}
    finally{fs.rmSync(path.join(lock,'owner.json'),{force:true});fs.rmdirSync(lock);}
  }
  function publish(before,c) {
    if(!equal(bytes(configPath),before))throw Error('CONCURRENT_EDIT');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(before){const backups=path.join(directory,'manager-backups');fs.mkdirSync(backups,{recursive:true,mode:0o700});fs.writeFileSync(path.join(backups,Date.now()+'-'+randomUUID()+'.json'),before,{mode:0o600,flag:'wx'});}
    const next=Buffer.from(JSON.stringify(c,null,2)+'\n');atomic(configPath,next);return next;
  }
  async function defaults() {
    const c=settings();if(c)return {port:c.port,controlPort:c.controlPort??18786};
    const port=await choosePort(env.WSL_DISTRO_NAME?18789:18788,[],portAvailable);
    return {port,controlPort:await choosePort(env.WSL_DISTRO_NAME?18791:18790,[port],portAvailable)};
  }
  async function configureConnection(input) {
    return locked(async()=>{
      const before=bytes(configPath),old=settings();let freshKey,published;
      const c={...await defaults(),...old,upstreamUrl:normalizeUrl(input.upstreamUrl),compression:input.compression??old?.compression??true};
      for(const k of ['port','controlPort'])if(input[k]!==undefined)c[k]=validatePort(input[k]);
      if(c.port===c.controlPort)throw Error('INVALID_PORT');
      if(old&&(c.port!==old.port||c.controlPort!==(old.controlPort??18786)))throw Error('PORT_CHANGE_REQUIRES_REINSTALL');
      if(typeof c.compression!=='boolean')throw Error('INVALID_COMPRESSION');
      c.management=input.local?{mode:'local',repo:fs.realpathSync(repo)}:input.management??(old?.management?.mode!=='local'?old?.management:null)??null;
      let key;
      if(input.key!==undefined)key=validateKey(input.key);
      else if(input.keyFile){c.keyFile=path.resolve(input.keyFile);key=keyOf(c);}
      else if(old){c.keyFile=old.keyFile;key=keyOf(c);}
      else throw Error('KEY_REQUIRED');
      if(c.management&&c.management.mode!=='local'&&c.management.host?.split('@').at(-1)!==new URL(c.upstreamUrl).hostname)c.management=null;
      await gateway(c,key);
      try {
        if(input.key!==undefined){freshKey=path.join(directory,'gateway-key-'+randomUUID());fs.writeFileSync(freshKey,key,{mode:0o600,flag:'wx'});c.keyFile=freshKey;}
        published=publish(before,c);
        // The installer owns runtime/service rollback. Keep the selected config
        // if a later stage fails so re-running the wizard can repair that stage.
        await installLocalUnlocked(c);
        return {ok:true,controlUrl:`http://127.0.0.1:${c.controlPort}/`,restartCodex:true};
      }catch(e){
        if(!published&&freshKey)fs.rmSync(freshKey,{force:true});
        if(published&&(e.message==='BRIDGE_INSTALL_FAILED'||before&&e.message==='CLIENT_INSTALL_FAILED')){
          if(!equal(bytes(configPath),published))throw Error('CONCURRENT_EDIT');
          if(before)atomic(configPath,before);else fs.rmSync(configPath,{force:true});
          if(freshKey)fs.rmSync(freshKey,{force:true});
        }
        throw e;
      }
    });
  }
  async function installLocalUnlocked(c) {
    const common=['--'+serviceScope(),'--codex-home',home,'--node-path',nodePath];
    try{await command(nodePath,[script('install-native-bridge-linux.mjs'),...common,'--upstream-url',c.upstreamUrl,'--key-file',c.keyFile,'--port',String(c.port)],{timeout:120000});}
    catch{throw Error('BRIDGE_INSTALL_FAILED');}
    try{await client(['configure','--provider','openai','--url',c.upstreamUrl,'--key-file',c.keyFile,'--codex-home',home,'--bridge-url',`http://127.0.0.1:${c.port}/v1`]);}
    catch{throw Error('CLIENT_INSTALL_FAILED');}
    try{await command(nodePath,[script('install-control-panel-linux.mjs'),...common],{timeout:120000});}
    catch{throw Error('PANEL_INSTALL_FAILED');}
  }
  const clientArgs=(action,c)=>[action,'--url',c.upstreamUrl,'--key-file',c.keyFile,'--codex-home',home];
  async function installServer({bindAddress='127.0.0.1',port=18787,adminPort=20100,latest=false,linger=false,adopt=false}={}) {
    return locked(async()=>{
      const scope=serviceScope(),pre=await requirements({server:true,scope,run:command});if(!pre.ok)throw Error(pre.systemd?'DEPENDENCIES_MISSING':'SYSTEMD_UNAVAILABLE');
      const oldEnv=readEnvironment(path.join(repo,'.env'));
      if(!oldEnv){
        if(!(await portAvailable(port))||!(await portAvailable(adminPort)))throw Error('PORT_IN_USE');
        await show('python3',[path.join(repo,'stack'),'init']);configureNewEnvironment(path.join(repo,'.env'),{bindAddress,port,adminPort});
      }
      const cfg=readEnvironment(path.join(repo,'.env'));
      // Inspect the target before any build or service migration. Never adopt an
      // unrelated container that happens to have the same name.
      const preflight=JSON.parse(await command('python3',[script('install-stack-service.py'),'status','--'+scope]));
      if(preflight.ok===false||preflight.installed&&!preflight.owned&&(!adopt||!preflight.adoptable))throw Error('SERVER_OWNERSHIP_FAILED');
      let image=false;try{await command('podman',['image','exists',bytes(path.join(repo,'data/active-image'))?.toString().trim()||cfg.IMAGE]);image=true;}catch{}
      if(!image)await show('python3',[path.join(repo,'stack'),'build']);
      // The service installer launches a first container or adopts a verified
      // existing one; it also handles rollback and boot registration.
      await show('python3',[script('install-stack-service.py'),'install','--'+scope,...(linger?['--enable-linger']:[]),...(adopt?['--adopt-existing']:[])]);
      if(latest)await show('python3',[path.join(repo,'stack'),'update','--latest']);
      const address=['0.0.0.0','::',''].includes(cfg.BIND_ADDRESS)?'127.0.0.1':cfg.BIND_ADDRESS;
      const tls=Boolean(cfg.GATEWAY_TLS_CERT&&cfg.GATEWAY_TLS_KEY),prior=settings();
      const upstreamUrl=prior?.management?.mode==='local'?prior.upstreamUrl:`${tls?'https':'http'}://${address}:${cfg.PORT}/v1`;
      return {ok:true,upstreamUrl,keyFile:path.join(repo,'secrets/gateway-key'),adminPort:cfg.ADMIN_PORT,scope,tls};
    });
  }
  async function updateGit() {
    const c=required();localManagement(c);
    return locked(async()=>{
      await show('python3',[path.join(repo,'stack'),'git-update']);
      // Do not reinstall from module objects cached before the pull. Re-exec the
      // launcher on the next run so its new lockfile and installer code load.
      return {ok:true,relaunchRequired:true};
    });
  }
  return {repo,codexHome:home,configPath,settings,defaults,serviceScope,status,gateway,
    requirements:server=>requirements({server,scope:serviceScope(),run:command}),
    installServer,configureConnection,updateGit,
    installLocal:()=>locked(()=>installLocalUnlocked(required())),
    setCompression:enabled=>locked(async()=>{if(typeof enabled!=='boolean')throw Error('INVALID_COMPRESSION');const before=bytes(configPath),c=required();await gateway(c);c.compression=enabled;publish(before,c);return {ok:true,compression:enabled};}),
    sync:()=>locked(()=>client(clientArgs('sync',required()))),
    doctor:()=>{const c=required();return client([...clientArgs('doctor',c),'--provider','openai','--bridge-url',`http://127.0.0.1:${c.port}/v1`]);},
    versions:()=>{const c=required();if(!c.management)throw Error('SERVER_MANAGEMENT_REQUIRED');return remote(c,'check');},
    login:()=>show(nodePath,[path.join(repo,'node_modules/@openai/codex/bin/codex.js'),'login','--device-auth'],{env:{...env,CODEX_HOME:home}}),
    startCodex:(workdir=process.cwd())=>{const cwd=path.resolve(workdir);if(!fs.statSync(cwd).isDirectory())throw Error('CONFIG_UNREADABLE');return show(nodePath,[path.join(repo,'node_modules/@openai/codex/bin/codex.js')],{cwd,env:{...env,CODEX_HOME:home}});},
    restartServer:()=>locked(async()=>{localManagement(required());await show('python3',[script('install-stack-service.py'),'restart','--'+serviceScope()]);return {ok:true};}),
    installDependencies:async missing=>{const p=await dependencyPlan(missing,{run:command});await show(uid===0?p.command:'sudo',uid===0?p.args:[p.command,...p.args]);return requirements({server:missing.includes('podman')||missing.includes('slirp4netns'),scope:serviceScope(),run:command});},
    authorizeLinger:()=>uid===0?Promise.resolve():show('sudo',['-v']),
    enableClientLinger:()=>show('sudo',['loginctl','enable-linger',os.userInfo().username]),
    isWsl:Boolean(env.WSL_DISTRO_NAME),uid,platform
  };
}
const codes=new Set(('USAGE INVALID_URL INVALID_GATEWAY_KEY INVALID_PORT NO_FREE_PORT CONFIG_INVALID CONFIG_UNREADABLE KEY_REQUIRED KEY_FILE_UNREADABLE INVALID_BIND INVALID_COMPRESSION INVALID_SERVER_RESPONSE GATEWAY_UNAVAILABLE GATEWAY_KEY_REJECTED SERVER_UPGRADE_REQUIRED SCOPE_MISMATCH LOCAL_SERVER_REQUIRED SERVER_MANAGEMENT_REQUIRED NOT_CONFIGURED MANAGER_BUSY CONCURRENT_EDIT PORT_CHANGE_REQUIRES_REINSTALL BRIDGE_INSTALL_FAILED CLIENT_INSTALL_FAILED PANEL_INSTALL_FAILED COMMAND_FAILED CANCELLED DEPENDENCIES_MISSING SYSTEMD_UNAVAILABLE UNSUPPORTED_DEPENDENCY PODMAN_REPOSITORY_TOO_OLD PACKAGE_MANAGER_UNSUPPORTED PORT_IN_USE SERVER_OWNERSHIP_FAILED TTY_REQUIRED INVALID_SELECTION').split(' '));
export function safeError(e){const code=e?.code??e?.message;return codes.has(code)?code:'OPERATION_FAILED';}
