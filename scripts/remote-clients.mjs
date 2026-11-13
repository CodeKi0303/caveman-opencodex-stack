import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {sanitizeRemoteResult} from './remote-client-worker.mjs';

const actions=new Set(['status','apply','sync','doctor']);
const fail=code=>{throw Object.assign(Error(code),{code});};
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value)?value:'REMOTE_CLIENT_FAILED';
const invalidText=value=>typeof value!=='string'||value.length>2048||/[\x00-\x1f\x7f]/.test(value);

export function validateRemoteTarget(value,{checkKeyFile=true}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_REMOTE_TARGET');
  const platform=value.platform??'linux';
  if(!['linux','windows'].includes(platform))fail('INVALID_REMOTE_PLATFORM');
  if(typeof value.host!=='string'||value.host.length>253||!/^([a-z_][a-z0-9_.-]*@)?[a-z0-9_][a-z0-9_.:-]*$/i.test(value.host))fail('INVALID_REMOTE_HOST');
  const port=value.port??22;
  if(!Number.isInteger(port)||port<1||port>65535)fail('INVALID_REMOTE_PORT');
  const paths=platform==='windows'?path.win32:path.posix;
  const isAbsolute=file=>!invalidText(file)&&paths.isAbsolute(file)&&(platform!=='windows'||/^[a-z]:[/\\]/i.test(file));
  if(!isAbsolute(value.configPath))fail('INVALID_REMOTE_CONFIG');
  let configPath=paths.normalize(value.configPath);
  if(paths.basename(configPath)==='config.toml')configPath=paths.join(paths.dirname(configPath),'caveman-stack','native-bridge.json');
  if(paths.basename(configPath)!=='native-bridge.json')fail('INVALID_REMOTE_CONFIG');
  const id=value.id??createHash('sha256').update(platform+'\0'+value.host+'\0'+port+'\0'+configPath).digest('hex').slice(0,16);
  if(typeof id!=='string'||!/^[a-z0-9_-]{1,64}$/i.test(id))fail('INVALID_REMOTE_ID');
  const label=value.label?.trim()||value.host;
  if(invalidText(label)||label.length>100)fail('INVALID_REMOTE_LABEL');
  let keyFile;
  if(value.keyFile) {
    if(invalidText(value.keyFile)||!path.isAbsolute(value.keyFile))fail('INVALID_REMOTE_SSH_KEY');
    keyFile=path.normalize(value.keyFile);
    if(checkKeyFile)try{if(!fs.statSync(keyFile).isFile())fail('SSH_KEY_UNREADABLE');}catch{fail('SSH_KEY_UNREADABLE');}
  }
  let nodePath;
  if(value.nodePath){if(!isAbsolute(value.nodePath))fail('INVALID_REMOTE_NODE_PATH');nodePath=paths.normalize(value.nodePath);}
  return {id,label,host:value.host,port,platform,configPath,...(keyFile?{keyFile}:{}),...(nodePath?{nodePath}:{})};
}

export function validateRemoteTargets(value,options) {
  if(!Array.isArray(value)||value.length>50)fail('INVALID_REMOTE_TARGETS');
  const targets=value.map(target=>validateRemoteTarget(target,options));
  if(new Set(targets.map(target=>target.id)).size!==targets.length)fail('DUPLICATE_REMOTE_TARGET');
  const addresses=targets.map(target=>JSON.stringify([target.platform,target.host.toLowerCase(),target.port,target.configPath]));
  if(new Set(addresses).size!==targets.length)fail('DUPLICATE_REMOTE_TARGET');
  return targets;
}

function validateSettings(settings) {
  if(!settings||typeof settings!=='object'||typeof settings.compression!=='boolean'||!['forward','server'].includes(settings.clientAuthMode))fail('INVALID_REMOTE_SETTINGS');
  let upstream;try{upstream=new URL(settings.upstreamUrl);}catch{fail('INVALID_REMOTE_SETTINGS');}
  if(!['http:','https:'].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash||!['/v1','/v1/'].includes(upstream.pathname))fail('INVALID_REMOTE_SETTINGS');
  if(typeof settings.key!=='string'||settings.key.length<32||settings.key.length>4096||/[\r\n]/.test(settings.key))fail('INVALID_REMOTE_KEY');
  upstream.pathname='/v1';
  return {upstreamUrl:upstream.href,key:settings.key,compression:settings.compression,clientAuthMode:settings.clientAuthMode};
}

function validateSyncOptions(value) {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['expectedUpstreamUrl','sourceControlInstance','requireCacheRepair'].includes(key)))fail('INVALID_REMOTE_SETTINGS');
  const result={};
  if(value.expectedUpstreamUrl!==undefined){
    let url;try{url=new URL(value.expectedUpstreamUrl);}catch{fail('INVALID_REMOTE_SETTINGS');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['/v1','/v1/'].includes(url.pathname))fail('INVALID_REMOTE_SETTINGS');
    url.pathname='/v1';result.expectedUpstreamUrl=url.href;
  }
  if(value.sourceControlInstance!==undefined){
    if(typeof value.sourceControlInstance!=='string'||!/^[a-z0-9-]{1,64}$/i.test(value.sourceControlInstance))fail('INVALID_REMOTE_SETTINGS');
    result.sourceControlInstance=value.sourceControlInstance;
  }
  if(value.requireCacheRepair!==undefined){if(typeof value.requireCacheRepair!=='boolean')fail('INVALID_REMOTE_SETTINGS');result.requireCacheRepair=value.requireCacheRepair;}
  return result;
}

// Neither bootstrap interpolates a host, path or credential into shell code.
// Only this constant source is encoded in argv; all values and worker source use stdin.
const linuxBootstrap=String.raw`import base64,json,os,shutil,subprocess,sys
def main():
 e=json.load(sys.stdin); r=e['request']; p=r['configPath']; d=os.path.dirname(p)
 if not os.path.isfile(p): raise RuntimeError('REMOTE_CONFIG_UNREADABLE')
 node=e.get('nodePath')
 if not node:
  for name in ('control-panel-install-linux.json','native-bridge-install-linux.json'):
   try:
    m=json.load(open(os.path.join(d,name),encoding='utf-8'))
    if m.get('managedBy')=='caveman-opencodex-stack' and os.path.realpath(m.get('configPath',''))==os.path.realpath(p) and os.path.isfile(m.get('nodePath','')):
     node=m['nodePath']; break
   except (OSError,ValueError,TypeError): pass
 node=node or shutil.which('node')
 if not node: raise RuntimeError('REMOTE_NODE_UNAVAILABLE')
 source=base64.b64decode(e['worker']).decode('utf-8')
 data=base64.b64encode(json.dumps(r).encode()).decode()
 source+='\nawait remoteClientWorkerMain(JSON.parse(Buffer.from("'+data+'","base64").toString("utf8")));\n'
 result=subprocess.run([node,'--input-type=module','-'],input=source.encode(),stdout=sys.stdout,stderr=subprocess.DEVNULL)
 return result.returncode
try: sys.exit(main())
except Exception:
 print(json.dumps({'ok':False,'error':'REMOTE_BOOTSTRAP_FAILED'})); sys.exit(1)
`;
const windowsBootstrap=String.raw`$ErrorActionPreference='Stop'
try {
 $envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $request=$envelope.request
 $configPath=[string]$request.configPath
 if(-not(Test-Path -LiteralPath $configPath -PathType Leaf)){throw 'missing'}
 $nodePath=[string]$envelope.nodePath
 if(-not $nodePath){
  $manifestPath=Join-Path (Split-Path -Parent $configPath) 'native-bridge-install.json'
  if(Test-Path -LiteralPath $manifestPath -PathType Leaf){
   $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
   if($manifest.managedBy -eq 'caveman-opencodex-stack' -and $manifest.configPath -ieq $configPath -and (Test-Path -LiteralPath $manifest.nodePath -PathType Leaf)){$nodePath=[string]$manifest.nodePath}
  }
 }
 if(-not $nodePath){$nodePath=(Get-Command node.exe -CommandType Application | Select-Object -First 1).Source}
 $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.worker))
 $data=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 10 -Compress)))
 $source+=[Environment]::NewLine+'await remoteClientWorkerMain(JSON.parse(Buffer.from("'+$data+'","base64").toString("utf8")));'
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=$nodePath; $start.Arguments='--input-type=module -'; $start.UseShellExecute=$false
 $start.CreateNoWindow=$true; $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
 $process=New-Object Diagnostics.Process; $process.StartInfo=$start
 [void]$process.Start(); $output=$process.StandardOutput.ReadToEndAsync(); $errors=$process.StandardError.ReadToEndAsync()
 $process.StandardInput.Write($source); $process.StandardInput.Close(); $process.WaitForExit()
 [Console]::Out.Write($output.GetAwaiter().GetResult()); exit $process.ExitCode
} catch { [Console]::Out.WriteLine('{"ok":false,"error":"REMOTE_BOOTSTRAP_FAILED"}'); exit 1 }
`;

export function buildRemoteClientRequest(target,action,settings,{checkKeyFile=true}={}) {
  const t=validateRemoteTarget(target,{checkKeyFile});
  if(!actions.has(action))fail('INVALID_REMOTE_ACTION');
  const request={action,configPath:t.configPath,...(action==='apply'?{settings:validateSettings(settings)}:
    action==='sync'?validateSyncOptions(settings):{})};
  const command=t.platform==='windows'
    ?'powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(windowsBootstrap,'utf16le').toString('base64')
    :`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(linuxBootstrap).toString('base64')}'))"`;
  const args=['-T','-p',String(t.port),...(t.keyFile?['-i',t.keyFile,'-o','IdentitiesOnly=yes']:[]),
    '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',t.host,command];
  const stdin=JSON.stringify({request,...(t.nodePath?{nodePath:t.nodePath}:{}),worker:fs.readFileSync(new URL('./remote-client-worker.mjs',import.meta.url)).toString('base64')});
  return {target:t,command:'ssh',args,stdin};
}

export function remoteClientCommand(target,action,settings,{spawnFn=spawn,timeoutMs=action==='status'?30000:120000,checkKeyFile=true}={}) {
  const plan=buildRemoteClientRequest(target,action,settings,{checkKeyFile});
  return new Promise((resolve,reject)=>{
    let done=false,output='',overflow=false;
    const child=spawnFn(plan.command,plan.args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{finish(Error('REMOTE_SSH_TIMEOUT'));child.kill();},timeoutMs);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>256*1024){overflow=true;child.kill();finish(Error('REMOTE_RESPONSE_TOO_LARGE'));}});
    child.stderr.resume();
    child.on('error',()=>finish(Error('REMOTE_SSH_UNAVAILABLE')));
    child.on('close',code=>{
      if(done||overflow)return;
      try{
        const result=JSON.parse(output);
        if(!result||typeof result!=='object'||typeof result.ok!=='boolean')throw Error();
        if(code!==0&&result.ok)throw Error();
        finish(null,sanitizeRemoteResult(action,result));
      }catch{finish(Error(code===255?'REMOTE_SSH_FAILED':'REMOTE_RESPONSE_INVALID'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(plan.stdin);
  });
}

export async function runRemoteClients(targets,ids,action,settings,{command=remoteClientCommand,...options}={}) {
  const list=validateRemoteTargets(targets,{checkKeyFile:false});
  if(!actions.has(action))fail('INVALID_REMOTE_ACTION');
  if(action==='apply')settings=validateSettings(settings);
  if(action==='sync')settings=validateSyncOptions(settings);
  if(ids!=='all'&&(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length))fail('INVALID_REMOTE_SELECTION');
  const selected=ids==='all'?list:list.filter(t=>ids.includes(t.id));
  if(!selected.length||(ids!=='all'&&selected.length!==ids.length))fail('INVALID_REMOTE_SELECTION');
  const results=new Array(selected.length);let next=0;
  await Promise.all(Array.from({length:Math.min(3,selected.length)},async()=>{
    while(next<selected.length){const index=next++,target=selected[index];
      try{const result=await command(target,action,settings,options);results[index]={id:target.id,label:target.label,host:target.host,ok:result.ok===true,result};}
      catch(error){results[index]={id:target.id,label:target.label,host:target.host,ok:false,error:safeCode(error.code??error.message)};}
    }
  }));
  return {ok:results.every(result=>result.ok),action,results};
}
