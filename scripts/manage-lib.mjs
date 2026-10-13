import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runClient, validateCatalog} from './client-lib.mjs';
import {remoteCommand} from './control-panel.mjs';

const execute = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const readBytes = file => {try {return fs.readFileSync(file);} catch (error) {if (error.code === 'ENOENT') return null; throw Error('CONFIG_UNREADABLE');}};
const same = (a,b) => a === null ? b === null : b !== null && a.equals(b);
const atomic = (file,bytes) => {
  const temporary = file + '.tmp-' + randomUUID();
  try {fs.writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'}); fs.renameSync(temporary,file);}
  finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
};

export function normalizeUrl(value) {
  let url;
  try {url = new URL(value);} catch {throw Error('INVALID_URL');}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/','/v1','/v1/'].includes(url.pathname)) throw Error('INVALID_URL');
  url.pathname = '/v1'; return url.href;
}

export function validateKey(value) {
  if (typeof value !== 'string') throw Error('INVALID_GATEWAY_KEY');
  const key = value.trim();
  if (key.length < 32 || key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) throw Error('INVALID_GATEWAY_KEY');
  return key;
}

export function validateManagement(value,upstreamUrl) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value.host !== 'string' || !/^([a-z_][a-z0-9_-]*@)?[a-z0-9.-]+$/i.test(value.host) || value.host.startsWith('-') ||
      !path.isAbsolute(value.keyFile ?? '') || typeof value.repo !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(value.repo) || value.repo.split('/').includes('..')) throw Error('INVALID_SSH_SETTINGS');
  if (value.host.split('@').at(-1).toLowerCase() !== new URL(upstreamUrl).hostname.toLowerCase()) throw Error('SSH_TARGET_MISMATCH');
  try {if (!fs.statSync(value.keyFile).isFile()) throw Error();} catch {throw Error('SSH_KEY_UNREADABLE');}
  return {host:value.host,keyFile:path.resolve(value.keyFile),repo:value.repo};
}

export function parseManagerArgs(argv,{env=process.env,home=os.homedir()}={}) {
  const options = {};
  for (let index=0; index<argv.length; index++) {
    const arg=argv[index];
    if (['--help','--status'].includes(arg)) {if (options[arg.slice(2)]) throw Error('USAGE'); options[arg.slice(2)]=true;}
    else if (['--headless','--with-web-ui'].includes(arg)) {if (options.webUiEnabled!==undefined) throw Error('USAGE'); options.webUiEnabled=arg==='--with-web-ui';}
    else if (['--system','--user'].includes(arg)) {if (options.scope) throw Error('USAGE'); options.scope=arg.slice(2);}
    else if (arg==='--codex-home') {if (options.codexHome || !argv[index+1] || argv[index+1].startsWith('--')) throw Error('USAGE'); options.codexHome=argv[++index];}
    else throw Error('USAGE');
  }
  options.codexHome=path.resolve(options.codexHome || env.CODEX_HOME || path.join(home,'.codex'));
  return options;
}

export async function runQuiet(command,args,{timeout=180000}={}) {
  try {return (await execute(command,args,{windowsHide:true,timeout,maxBuffer:1024*1024,encoding:'utf8'})).stdout;}
  catch {throw Error('LOCAL_COMMAND_FAILED');}
}

// A new key is created with restrictive permissions. Windows needs an explicit
// file ACL because mode 0600 alone does not remove inherited read permissions.
export async function protectKey(file,{platform=process.platform,run=runQuiet}={}) {
  if (platform!=='win32') {fs.chmodSync(file,0o600); return;}
  const sid=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{timeout:15000})).trim();
  if(!/^S-1-[0-9-]+$/.test(sid))throw Error('KEY_PERMISSIONS_FAILED');
  // The key file path is an argv value, never interpolated into shell source.
  await run('icacls.exe',[file,'/inheritance:r','/grant:r','*'+sid+':F'],{timeout:15000});
}

function parseStored(bytes) {
  if (!bytes) return null;
  try {
    const value=JSON.parse(bytes);
    if (!value || typeof value!=='object' || Array.isArray(value) || !path.isAbsolute(value.keyFile ?? '')) throw Error();
    value.upstreamUrl=normalizeUrl(value.upstreamUrl);
    for (const port of [value.port,value.controlPort??18786]) if (!Number.isInteger(port) || port<1024 || port>65535) throw Error();
    if (value.port===(value.controlPort??18786)) throw Error();
    return value;
  } catch {throw Error('CONFIG_INVALID');}
}

async function jsonRequest(fetchFn,url,options={},limit=16*1024*1024) {
  let response;
  try {response=await fetchFn(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});} catch {throw Error('GATEWAY_UNAVAILABLE');}
  if (!response.ok) throw Error(response.status===401 || response.status===403 ? 'GATEWAY_KEY_REJECTED' : response.status===404 ? 'SERVER_UPGRADE_REQUIRED' : 'GATEWAY_UNAVAILABLE');
  try {
    if (Number(response.headers.get('content-length'))>limit) throw Error();
    const reader=response.body.getReader(); let total=0; const chunks=[];
    try {for (;;) {const {done,value}=await reader.read(); if(done) break; total+=value.byteLength; if(total>limit) throw Error(); chunks.push(Buffer.from(value));}}
    finally {await reader.cancel().catch(()=>{});}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {throw Error('INVALID_SERVER_RESPONSE');}
}

export function createManager({codexHome,scope,webUiEnabled:requestedWebUi,platform=process.platform,env=process.env,nodePath=process.execPath,
  fetchFn=fetch,client=runClient,remote=remoteCommand,run=runQuiet,secureFile=protectKey}={}) {
  if(requestedWebUi!==undefined&&typeof requestedWebUi!=='boolean')throw Error('USAGE');
  const webUiEnabled=requestedWebUi??platform==='win32',mode=webUiEnabled?'web-ui':'headless';
  const home=path.resolve(codexHome || env.CODEX_HOME || path.join(os.homedir(),'.codex'));
  const directory=path.join(home,'caveman-stack'),configPath=path.join(directory,'native-bridge.json');
  const settings=()=>parseStored(readBytes(configPath));
  const required=()=>{const c=settings();if(!c)throw Error('NOT_CONFIGURED');return c;};
  const keyOf=c=>{try{return validateKey(fs.readFileSync(c.keyFile,'utf8'));}catch{throw Error('KEY_FILE_UNREADABLE');}};
  function serviceScope() {
    if (scope) return scope;
    try {const manifest=JSON.parse(fs.readFileSync(path.join(directory,'native-bridge-install-linux.json'),'utf8')); return manifest.unitPath?.startsWith('/etc/systemd/system/')?'system':'user';}catch{return 'user';}
  }
  const defaultPorts = env.WSL_DISTRO_NAME ? {port:18789,controlPort:18785} : {port:18788,controlPort:18786};
  async function gateway(c,key=keyOf(c)) {
    const headers={'x-caveman-gateway-key':key};
    const info=await jsonRequest(fetchFn,c.upstreamUrl+'/stack-info',{headers},65536);
    if (info.capabilities?.compressionSwitch!==true) throw Error('SERVER_UPGRADE_REQUIRED');
    const catalog=validateCatalog(await jsonRequest(fetchFn,c.upstreamUrl+'/catalog',{headers}));
    return {ok:true,compressionSwitch:true,models:catalog.models.length};
  }
  async function bridge(c) {
    try {
      const response=await fetchFn(`http://127.0.0.1:${c.port}/healthz`,{redirect:'error',signal:AbortSignal.timeout(2000)});
      const health=await response.json();
      return {ok:response.ok && health.service==='caveman-native-bridge' && health.ok===true && health.controlVersion===1 &&
        normalizeUrl(health.upstreamUrl??health.upstream)===c.upstreamUrl,hotReload:health.controlVersion===1,compression:health.compression};
    } catch {return {ok:false};}
  }
  async function status() {
    const c=settings();
    if(!c)return {ok:true,configured:false,codexHome:home,scope:serviceScope(),mode,webUiEnabled};
    let gatewayState;try{gatewayState=await gateway(c);}catch(error){gatewayState={ok:false,error:safeError(error)};}
    let keyConfigured=false;try{keyOf(c);keyConfigured=true;}catch{}
    return {ok:true,configured:true,codexHome:home,scope:serviceScope(),mode,webUiEnabled,settings:{upstreamUrl:c.upstreamUrl,compression:c.compression!==false,
      port:c.port,controlPort:c.controlPort??18786,keyConfigured,management:c.management?{host:c.management.host,repo:c.management.repo,keyConfigured:fs.existsSync(c.management.keyFile??'')}:null},
      bridge:await bridge(c),gateway:gatewayState,...(webUiEnabled?{controlUrl:`http://127.0.0.1:${c.controlPort??18786}/`}:{})};
  }
  async function publish(before,next) {
    if(!same(readBytes(configPath),before))throw Error('CONCURRENT_EDIT');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(before){const backup=path.join(directory,'manager-backups');fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.writeFileSync(path.join(backup,'bridge-'+Date.now()+'-'+randomUUID()+'.json'),before,{mode:0o600,flag:'wx'});}
    const bytes=Buffer.from(JSON.stringify(next,null,2)+'\n');atomic(configPath,bytes);return bytes;
  }
  async function saveConnection(input) {
    const before=readBytes(configPath),old=parseStored(before);
    let oldKey;try{if(old)oldKey=keyOf(old);}catch{}
    const next={...(old??defaultPorts),upstreamUrl:normalizeUrl(input.upstreamUrl),compression:input.compression??old?.compression??true};
    if(typeof next.compression!=='boolean')throw Error('INVALID_COMPRESSION');
    for(const name of ['port','controlPort']) if(input[name]!==undefined)next[name]=input[name];
    if(old&&(next.port!==old.port||(next.controlPort??18786)!==(old.controlPort??18786)))throw Error('PORT_CHANGE_REQUIRES_REINSTALL');
    for(const port of [next.port,next.controlPort??18786])if(!Number.isInteger(port)||port<1024||port>65535)throw Error('INVALID_PORT');
    if(next.port===(next.controlPort??18786))throw Error('INVALID_PORT');
    next.management=validateManagement(input.management===undefined?next.management:input.management,next.upstreamUrl);
    let key=input.key===undefined?oldKey:validateKey(input.key);
    if(input.importKey){const imported=await remote(next,'connection');key=validateKey(imported.gatewayKey);}
    if(!key)throw Error('KEY_REQUIRED');
    const remoteState=await gateway(next,key);
    // An existing hot-reloading bridge can adopt a new destination before the
    // transactional Codex reconfiguration. Fresh installs remain staged until
    // the installer has started and verified the bridge.
    const live=old && old.port===next.port ? await bridge(old) : {ok:false};
    let freshKey,published;
    try {
      if(!old || key!==oldKey){
        fs.mkdirSync(directory,{recursive:true,mode:0o700});freshKey=path.join(directory,'gateway-key-'+randomUUID());
        fs.writeFileSync(freshKey,key,{mode:0o600,flag:'wx'});await secureFile(freshKey,{platform,run});next.keyFile=freshKey;
      }
      published=await publish(before,next);
      if(live.ok){await client(['reconfigure','--provider','openai','--url',next.upstreamUrl,'--key-file',next.keyFile,'--codex-home',home,'--bridge-url',`http://127.0.0.1:${next.port}/v1`]);}
      return {ok:true,appliedToClient:live.ok,installRequired:!live.ok,models:remoteState.models,restartCodex:live.ok};
    } catch(error) {
      if(published){
        if(!same(readBytes(configPath),published))throw Error('ROLLBACK_CONFLICT');
        if(before)atomic(configPath,before);else fs.rmSync(configPath,{force:true});
      }
      if(freshKey)fs.rmSync(freshKey,{force:true});throw error;
    }
  }
  async function saveManagement(value) {
    const before=readBytes(configPath),c=required();c.management=validateManagement(value,c.upstreamUrl);
    // Read-only SSH status verifies the selected host, key and repository before
    // saving; the connection API never asks for or stores a shell password.
    if(c.management)await remote(c,'status');
    await publish(before,c);return {ok:true};
  }
  async function setCompression(enabled) {
    if(typeof enabled!=='boolean')throw Error('INVALID_COMPRESSION');
    const before=readBytes(configPath),c=required();await gateway(c);c.compression=enabled;await publish(before,c);
    const live=await bridge(c);return {ok:true,compression:enabled,applied:live.ok,installRequired:!live.ok};
  }
  const clientArgs=(command,c)=>[command,'--url',c.upstreamUrl,'--key-file',c.keyFile,'--codex-home',home];
  async function installLocal() {
    const c=required();await gateway(c);
    if(platform==='win32'){
      const common=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'];
      await run('powershell.exe',[...common,path.join(scripts,'install-native-bridge.ps1'),'-CodexHome',home,'-UpstreamUrl',c.upstreamUrl,'-KeyFile',c.keyFile,'-Port',String(c.port),'-NodePath',nodePath]);
    } else if(platform==='linux') {
      await run(nodePath,[path.join(scripts,'install-native-bridge-linux.mjs'),'--codex-home',home,'--upstream-url',c.upstreamUrl,'--key-file',c.keyFile,'--port',String(c.port),'--node-path',nodePath,'--'+serviceScope()]);
    } else throw Error('UNSUPPORTED_PLATFORM');
    let configured;
    try{configured=await client([...clientArgs('configure',c),'--provider','openai','--bridge-url',`http://127.0.0.1:${c.port}/v1`]);}
    catch{throw Error('BRIDGE_INSTALLED_CLIENT_FAILED');}
    if(webUiEnabled){
      try {
        if(platform==='win32')await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(scripts,'install-control-panel.ps1'),'-CodexHome',home,'-NodePath',nodePath]);
        else await run(nodePath,[path.join(scripts,'install-control-panel-linux.mjs'),'--codex-home',home,'--node-path',nodePath,'--'+serviceScope()]);
      }catch{throw Error('BRIDGE_INSTALLED_PANEL_FAILED');}
    }
    return {ok:true,restartCodex:configured.restartCodex,mode,webUiEnabled,...(webUiEnabled?{controlUrl:`http://127.0.0.1:${c.controlPort??18786}/`}:{}),scope:serviceScope()};
  }
  async function remoteOperation(action) {
    if(!['status','check','restart','git-update','latest-update','catalog'].includes(action))throw Error('INVALID_ACTION');
    const c=required();validateManagement(c.management,c.upstreamUrl);return remote(c,action);
  }
  return {codexHome:home,configPath,mode,webUiEnabled,settings,defaults:defaultPorts,serviceScope,status,saveConnection,saveManagement,setCompression,installLocal,
    restartLocal:installLocal,sync:()=>client(clientArgs('sync',required())),doctor:()=>{const c=required();return client([...clientArgs('doctor',c),'--provider','openai','--bridge-url',`http://127.0.0.1:${c.port}/v1`]);},remoteOperation};
}

const safeCodes=new Set(('USAGE CANCELLED INPUT_FAILED TTY_REQUIRED OPERATION_FAILED INVALID_URL INVALID_GATEWAY_KEY KEY_FILE_UNREADABLE KEY_REQUIRED KEY_PERMISSIONS_FAILED '+
  'GATEWAY_KEY_REJECTED GATEWAY_UNAVAILABLE INVALID_SERVER_RESPONSE SERVER_UPGRADE_REQUIRED BRIDGE_UPGRADE_REQUIRED BRIDGE_INSTALLED_PANEL_FAILED BRIDGE_INSTALLED_CLIENT_FAILED '+
  'INVALID_SSH_SETTINGS SSH_KEY_UNREADABLE SSH_TARGET_MISMATCH SSH_NOT_CONFIGURED SSH_UNAVAILABLE SSH_TIMEOUT SERVER_OPERATION_FAILED LOCAL_COMMAND_FAILED SERVER_BUSY GIT_DIRTY '+
  'NOT_CONFIGURED CONFIG_INVALID CONFIG_UNREADABLE INVALID_PORT PORT_CHANGE_REQUIRES_REINSTALL CONCURRENT_EDIT ROLLBACK_CONFLICT UNSUPPORTED_PLATFORM INVALID_ACTION INVALID_COMPRESSION INVALID_SELECTION '+
  'INVALID_CATALOG CATALOG_UNREACHABLE CONFIG_MERGE_REQUIRED WRITE_FAILED ROLLBACK_FAILED SERVER_NOT_INSTALLED INSUFFICIENT_DISK GIT_UNAVAILABLE').split(' '));
export function safeError(error) {
  const code=error?.code??error?.message;
  return safeCodes.has(code)?code:'OPERATION_FAILED';
}
