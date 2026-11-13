import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runClient} from './client-lib.mjs';
import {summarizeCatalog} from './catalog-summary.mjs';
import {validateRemoteTarget,validateRemoteTargets,runRemoteClients} from './remote-clients.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const updateComponents=['caveman','opencodex','codex'];
export function validateUpdatePlan(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_UPDATE_SELECTION');
 const batch=Object.hasOwn(value,'updates');
 if(batch&&(Object.hasOwn(value,'component')||Object.hasOwn(value,'version')))throw Error('INVALID_UPDATE_SELECTION');
 const updates=batch?value.updates:[{component:value.component,version:value.version}];
 if(!Array.isArray(updates)||updates.length<1||updates.length>updateComponents.length)throw Error('INVALID_UPDATE_SELECTION');
 const seen=new Set();
 return updates.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['component','version'].includes(k))||
    !updateComponents.includes(item.component)||typeof item.version!=='string'||!/^\d+\.\d+\.\d+$/.test(item.version))throw Error('INVALID_VERSION');
  if(seen.has(item.component))throw Error('INVALID_UPDATE_SELECTION');seen.add(item.component);
  return {component:item.component,version:item.version};
 });
}
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function atomic(file,value){const tmp=file+'.tmp-'+randomUUID();try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function validUrl(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['/v1','/v1/'].includes(u.pathname))throw Error('INVALID_URL');u.pathname='/v1';return u.href;}
export function validateManagement(value,{platform=process.platform}={}){
 if(value===null)return null;
 if(value?.mode==='local'){
  if(platform!=='linux'||!path.isAbsolute(value.repo??''))throw Error('INVALID_LOCAL_MANAGEMENT');
  try{if(fs.realpathSync(value.repo)!==fs.realpathSync(path.dirname(directory)))throw Error();}catch{throw Error('INVALID_LOCAL_MANAGEMENT');}
  return {mode:'local',repo:fs.realpathSync(value.repo)};
 }
 if(value?.mode!==undefined&&value.mode!=='ssh')throw Error('INVALID_SSH_SETTINGS');
 if(!value||typeof value.host!=='string'||!/^([a-z_][a-z0-9_-]*@)?[a-z0-9.-]+$/i.test(value.host)||value.host.startsWith('-')||
   !path.isAbsolute(value.keyFile??'')||typeof value.repo!=='string'||!/^\/[a-zA-Z0-9_./-]+$/.test(value.repo)||value.repo.split('/').includes('..'))throw Error('INVALID_SSH_SETTINGS');
 if(!fs.statSync(value.keyFile).isFile())throw Error('SSH_KEY_UNREADABLE');
 return {host:value.host,keyFile:value.keyFile,repo:value.repo};
}
export function remoteCommand(settings,action,args={}, {platform=process.platform,spawnFn=spawn,timeoutMs=action==='status'?8000:40*60*1000}={}){
 if(!['status','check','catalog','update'].includes(action)||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(name=>action!=='update'||!['component','version','updates'].includes(name)))throw Error('INVALID_SERVER_ACTION');
 if(action==='update')validateUpdatePlan(args);
 const m=validateManagement(settings.management,{platform});
 if(!m)throw Error('SSH_NOT_CONFIGURED');
 const local=m.mode==='local';
 if(!local&&m.host.split('@').at(-1).toLowerCase()!==new URL(settings.upstreamUrl).hostname.toLowerCase())throw Error('SSH_TARGET_MISMATCH');
 const source=local?null:fs.readFileSync(path.join(directory,'server-control.py')).toString('base64');
 return new Promise((resolve,reject)=>{
  const child=spawnFn(local?'python3':'ssh',local?[path.join(directory,'server-control.py')]:['-T','-i',m.keyFile,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',m.host,
   `python3 -c "import base64;exec(base64.b64decode('${source}'))"`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024)child.kill();});child.stderr.resume();
  const timer=setTimeout(()=>{child.kill();reject(Error(local?'LOCAL_MANAGEMENT_TIMEOUT':'SSH_TIMEOUT'));},timeoutMs);
  child.on('error',()=>{clearTimeout(timer);reject(Error(local?'LOCAL_MANAGEMENT_UNAVAILABLE':'SSH_UNAVAILABLE'));});
  child.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code!==0||result?.ok!==true)throw Error(result?.error||'SERVER_OPERATION_FAILED');resolve(result);}catch(error){reject(Error(/^[A-Z_]+$/.test(error.message)?error.message:'SERVER_OPERATION_FAILED'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({repo:m.repo,action,...args}));
 });
}
export function createControlPanel({configPath,fetchFn=fetch,client=runClient,remote=remoteCommand,remoteClients=runRemoteClients,platform=process.platform}={}){
 configPath=path.resolve(configPath);
 const home=path.dirname(path.dirname(configPath));
 const csrf=randomBytes(32).toString('hex');
 const controlInstance=randomUUID();
 let job=null,busy=false;
 const settings=()=>read(configPath);
 const targetsPath=path.join(path.dirname(configPath),'remote-clients.json');
 const targets=()=>fs.existsSync(targetsPath)?validateRemoteTargets(read(targetsPath).targets,{checkKeyFile:false}):[];
 const key=c=>fs.readFileSync(c.keyFile,'utf8').trim();
 const safeSettings=c=>({upstreamUrl:c.upstreamUrl,compression:c.compression!==false,clientAuthMode:c.clientAuthMode??'forward',keyConfigured:fs.existsSync(c.keyFile),bridgeUrl:`http://127.0.0.1:${c.port}/v1`,management:c.management??null});
 const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(value));
 async function gateway(c,suffix,timeoutMs=15000){const r=await fetchFn(c.upstreamUrl+suffix,{headers:{'x-caveman-gateway-key':key(c)},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});if(!r.ok)throw Error(r.status===401?'GATEWAY_KEY_REJECTED':'GATEWAY_UNAVAILABLE');return r.json();}
 let statusPending;
 async function readStatus(){
  const c=settings(),alerts=[];
  let bridge={ok:false},gatewayState={ok:false},authentication={mode:'unknown',source:'unavailable'};
  await Promise.all([
   (async()=>{try{const r=await fetchFn(`http://127.0.0.1:${c.port}/healthz`,{signal:AbortSignal.timeout(2000)});const b=await r.json();bridge={ok:r.ok&&b.service==='caveman-native-bridge',compression:b.compression,hotReload:b.controlVersion===1};}catch{}})(),
   (async()=>{try{const info=await gateway(c,'/stack-info',5000);gatewayState={ok:true,compressionSwitch:info.capabilities?.compressionSwitch===true};}catch(error){gatewayState.error=error.message==='GATEWAY_KEY_REJECTED'?'GATEWAY_KEY_REJECTED':'GATEWAY_UNAVAILABLE';}})(),
   (async()=>{if(!c.management)return;try{
    const result=await remote(c,'status',{});
    if(result.ok===true&&result.authentication?.source==='server'&&['pool','direct'].includes(result.authentication.mode))authentication={mode:result.authentication.mode,source:'server'};
   }catch{}})()
  ]);
  if(!bridge.ok)alerts.push({id:'bridge-unavailable',severity:'error',message:'로컬 브리지에 연결할 수 없습니다. 브리지 서비스 상태를 확인하세요.'});
  else if(!bridge.hotReload)alerts.push({id:'bridge-upgrade',severity:'warning',message:'실시간 설정 반영을 지원하는 브리지로 업데이트하세요.'});
  if(!gatewayState.ok)alerts.push({id:'gateway-unavailable',severity:'error',message:gatewayState.error==='GATEWAY_KEY_REJECTED'?'서버에서 게이트웨이 인증키를 거부했습니다. 연결 설정의 키를 확인하세요.':'Pod 게이트웨이에 연결할 수 없습니다. 서버 주소와 서비스 상태를 확인하세요.'});
  else if(!gatewayState.compressionSwitch)alerts.push({id:'gateway-upgrade',severity:'warning',message:'이 서버는 클라이언트별 압축 선택을 지원하지 않습니다. 게이트웨이를 업데이트하세요.'});
  if(bridge.ok&&typeof bridge.compression==='boolean'&&bridge.compression!==(c.compression!==false))alerts.push({id:'compression-mismatch',severity:'warning',message:'브리지의 압축 상태와 저장된 설정이 다릅니다. 다음 조회에서도 지속되면 브리지 서비스를 확인하세요.'});
  if(c.management&&authentication.source==='unavailable')alerts.push({id:'authentication-unknown',severity:'warning',message:'서버의 계정 선택 모드를 확인하지 못했습니다. 관리 연결과 서버 설정을 확인하세요.'});
  let catalog={count:0,totalCount:0,hiddenCount:0};try{const file=path.join(home,'opencodex-catalog.json'),data=read(file);if(!Array.isArray(data.models))throw Error();catalog={...summarizeCatalog(data),modified:fs.statSync(file).mtime.toISOString()};}catch{}
  if(catalog.totalCount===0)alerts.push({id:'catalog-empty',severity:'warning',message:'로컬 모델 목록이 비어 있습니다. 모델 목록 동기화를 실행하세요.'});
  else if(catalog.count===0)alerts.push({id:'catalog-no-selectable',severity:'warning',message:'선택 가능한 로컬 모델이 없습니다. OpenCodex에서 사용할 모델을 선택한 뒤 모델 목록을 동기화하세요.'});
  return {ok:true,checkedAt:new Date().toISOString(),controlInstance,capabilities:{remoteClientManagement:1,catalogSyncRepair:1},remoteClients:targets(),settings:safeSettings(c),bridge,gateway:gatewayState,authentication,alerts,catalog,job,busy};
 }
 function status(){return statusPending??=readStatus().finally(()=>{statusPending=undefined;});}
 async function save(body){
  const before=settings(),next={...before};
  next.upstreamUrl=validUrl(body.upstreamUrl);
  if(typeof body.compression!=='boolean')throw Error('INVALID_COMPRESSION');next.compression=body.compression;
  if(body.clientAuthMode!==undefined){
   if(!['forward','server'].includes(body.clientAuthMode))throw Error('INVALID_CLIENT_AUTH_MODE');
   next.clientAuthMode=body.clientAuthMode;
  }
  if(before.management?.mode==='local'){
   const local=validateManagement(before.management,{platform});
   if(next.upstreamUrl!==validUrl(before.upstreamUrl))throw Error('LOCAL_MANAGEMENT_LOCKED');
   if(body.management!==undefined&&(body.management?.mode!=='local'||body.management?.repo!==before.management.repo))throw Error('LOCAL_MANAGEMENT_LOCKED');
   next.management=local;
  }else{
   if(body.management?.mode==='local')throw Error('LOCAL_MANAGEMENT_LOCKED');
   if(body.management!==undefined)next.management=validateManagement(body.management,{platform});
  }
  if(body.key!==undefined&&body.key!==''&&(typeof body.key!=='string'||body.key.length<32||body.key.length>4096||/[\r\n]/.test(body.key)))throw Error('INVALID_KEY');
  let newKey;
  try{
   if(body.key){newKey=path.join(path.dirname(configPath),'gateway-key-'+randomUUID());fs.writeFileSync(newKey,body.key,{mode:0o600,flag:'wx'});next.keyFile=newKey;}
   const info=await gateway(next,'/stack-info');if(!info.capabilities?.compressionSwitch)throw Error('SERVER_UPGRADE_REQUIRED');
   const b=await fetchFn(`http://127.0.0.1:${before.port}/healthz`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
   if(b.controlVersion!==1)throw Error('BRIDGE_UPGRADE_REQUIRED');
   if(JSON.stringify(settings())!==JSON.stringify(before))throw Error('CONCURRENT_EDIT');
   const backup=path.join(path.dirname(configPath),'control-backups');fs.mkdirSync(backup,{recursive:true,mode:0o700});
   fs.copyFileSync(configPath,path.join(backup,'bridge-'+Date.now()+'.json'));
   atomic(configPath,next);
   try{await client(['reconfigure','--provider','openai','--url',next.upstreamUrl,'--key-file',next.keyFile,'--codex-home',home,'--bridge-url',`http://127.0.0.1:${next.port}/v1`]);}
   catch(error){atomic(configPath,before);throw error;}
   return {ok:true,message:'연결 설정을 저장했습니다. 새 요청부터 적용됩니다. Pod 주소·키를 바꿨다면 Codex를 재시작해 복구 MCP 설정도 반영하세요.'};
  }catch(error){if(newKey&&settings().keyFile!==newKey)fs.rmSync(newKey,{force:true});throw error;}
 }
 function saveTarget(body){
  const before=targets();let next;
  if(Object.hasOwn(body,'remove')){
   if(Object.hasOwn(body,'target')||typeof body.remove!=='string'||!before.some(t=>t.id===body.remove))throw Error('INVALID_REMOTE_TARGET');
   next=before.filter(t=>t.id!==body.remove);
  }else{
   const target=validateRemoteTarget(body.target);
   next=before.some(t=>t.id===target.id)?before.map(t=>t.id===target.id?target:t):[...before,target];
  }
  next=validateRemoteTargets(next,{checkKeyFile:false});
  if(fs.existsSync(targetsPath)){
   const backup=path.join(path.dirname(configPath),'control-backups');fs.mkdirSync(backup,{recursive:true,mode:0o700});
   fs.copyFileSync(targetsPath,path.join(backup,'remote-clients-'+randomUUID()+'.json'));
  }
  atomic(targetsPath,{targets:next});return {ok:true,remoteClients:next};
 }
 function validateRemoteAction(body){
  if(!['status','apply','sync','doctor'].includes(body.action)||!Array.isArray(body.ids)||!body.ids.length||
    new Set(body.ids).size!==body.ids.length||body.ids.some(id=>typeof id!=='string'||!targets().some(t=>t.id===id)))throw Error('INVALID_REMOTE_SELECTION');
  if(body.action==='apply'&&body.confirm!==true)throw Error('REMOTE_CONFIRMATION_REQUIRED');
 }
 const safeError=error=>/^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code??error?.message)?(error.code??error.message):'CLIENT_SYNC_FAILED';
 const syncSummary=result=>({ok:result.ok===true,changed:result.changed===true||result.catalogChanged===true||result.cacheChanged===true||result.configChanged===true,
  catalogChanged:result.catalogChanged===true,cacheChanged:result.cacheChanged===true,cacheRepaired:result.cacheRepaired===true,
  configChanged:result.configChanged===true,restartCodex:result.restartCodex===true,warnings:result.warnings??[]});
 async function syncLocal(c){
  if(validUrl(settings().upstreamUrl)!==validUrl(c.upstreamUrl))throw Error('CONCURRENT_EDIT');
  return syncSummary(await client(['sync','--url',c.upstreamUrl,'--key-file',c.keyFile,'--codex-home',home]));
 }
 async function syncLinkedClients(c){
  let local,remoteResult;
  try{local=await syncLocal(c);}catch(error){local={ok:false,error:safeError(error)};}
  try{
   const list=targets();
   remoteResult=list.length?await remoteClients(list,'all','sync',{
    expectedUpstreamUrl:c.upstreamUrl,sourceControlInstance:controlInstance,requireCacheRepair:true}):{ok:true,action:'sync',results:[]};
  }catch(error){remoteResult={ok:false,action:'sync',results:[],error:safeError(error)};}
  return {ok:local.ok&&remoteResult.ok,local,remote:remoteResult};
 }
 function startJob(action,body){
  busy=true;job={id:randomUUID(),action,status:'running',started:new Date().toISOString()};
  const c=settings();
  (async()=>{
   if(action==='remote-client-action'){
    job.result=await remoteClients(targets(),body.ids,body.action,body.action==='apply'?{
     upstreamUrl:c.upstreamUrl,key:key(c),compression:c.compression!==false,clientAuthMode:c.clientAuthMode??'forward'}:
     body.action==='sync'?{requireCacheRepair:true}:undefined);
    if(!job.result.ok)throw Error('REMOTE_CLIENTS_PARTIAL_FAILURE');
   }else if(action==='sync'||action==='doctor'){
    const result=await client([action==='sync'?'sync':'doctor','--url',c.upstreamUrl,'--key-file',c.keyFile,'--codex-home',home,...(action==='doctor'?['--provider','openai','--bridge-url',`http://127.0.0.1:${c.port}/v1`]:[])]);
    job.result=action==='sync'?syncSummary(result):result;
    if(!result.ok)throw Error('DOCTOR_FAILED');
   }else{
    job.result=await remote(c,action==='check-update'?'check':action==='refresh-server-catalog'?'catalog':'update',action==='update'?(Object.hasOwn(body,'updates')?{updates:validateUpdatePlan(body)}:{component:body.component,version:body.version}):{});
    if(action==='refresh-server-catalog'||action==='update'){
     if(job.result.ok!==true)throw Error('SERVER_OPERATION_FAILED');
     job.result={...job.result,serverApplied:true,...(action==='refresh-server-catalog'?{serverRefreshed:true}:{}),clientSync:null};
     job.phase='client-sync';
     // A matching server catalog says nothing about another PC's missing cache.
     // Always inspect every client, including after an unchanged server update.
     job.result.clientSync=await syncLinkedClients(c);
     job.result.restartCodex=job.result.clientSync.local.restartCodex===true;
     job.result.message=job.result.clientSync.ok?'서버 작업과 연결된 PC의 모델 목록 동기화를 완료했습니다.':
      '서버 작업은 완료했습니다. 일부 PC의 동기화 결과를 확인한 뒤 해당 PC만 다시 동기화하세요.';
     if(!job.result.clientSync.ok)job.status='partial';
    }
   }
   if(job.status!=='partial')job.status='succeeded';
  })().catch(error=>{job.status='failed';job.error=/^[A-Z_]+$/.test(error.code??error.message)?(error.code??error.message):'OPERATION_FAILED';}).finally(()=>{job.finished=new Date().toISOString();busy=false;});
  return {ok:true,job};
 }
 const server=http.createServer(async(req,res)=>{
  const expected=`127.0.0.1:${req.socket.localPort}`;
  if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==expected)return json(res,403,{error:'LOCAL_ONLY'});
  if(req.headers.origin&&req.headers.origin!==`http://${expected}`)return json(res,403,{error:'ORIGIN_REJECTED'});
  if(req.headers['sec-fetch-site']&&!['none','same-origin'].includes(req.headers['sec-fetch-site']))return json(res,403,{error:'ORIGIN_REJECTED'});
  if(req.method==='GET'&&['/','/app.js','/style.css'].includes(req.url)){
   const name=req.url==='/'?'index.html':req.url.slice(1);let data=fs.readFileSync(path.join(directory,'control-ui',name),'utf8');
   if(name==='index.html')data=data.replace('__CSRF__',csrf);
   res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"}).end(data);return;
  }
  if(req.headers['x-control-token']!==csrf)return json(res,403,{error:'CONTROL_TOKEN_REQUIRED'});
  try{
   if(req.method==='GET'&&req.url==='/api/status')return json(res,200,await status());
   if(req.method!=='POST'||!['/api/settings','/api/sync','/api/doctor','/api/check-update','/api/update','/api/refresh-server-catalog','/api/remote-clients','/api/remote-client-action'].includes(req.url))return json(res,404,{error:'NOT_FOUND'});
   if(busy)return json(res,409,{error:'OPERATION_BUSY'});
   if(req.headers['content-type']!=='application/json')return json(res,415,{error:'JSON_REQUIRED'});
   let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return json(res,413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
   const body=JSON.parse(Buffer.concat(chunks).toString());
   if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_INPUT');
   if(busy)return json(res,409,{error:'OPERATION_BUSY'});
   if(req.url==='/api/settings'){busy=true;try{return json(res,200,await save(body));}finally{busy=false;}}
   if(req.url==='/api/sync'&&body.expectedUpstreamUrl!==undefined&&validUrl(body.expectedUpstreamUrl)!==validUrl(settings().upstreamUrl))throw Error('REMOTE_POD_MISMATCH');
   if(req.url==='/api/remote-clients')return json(res,200,saveTarget(body));
   if(req.url==='/api/remote-client-action')validateRemoteAction(body);
   if(req.url==='/api/update')validateUpdatePlan(body);
   if(req.url==='/api/update'&&body.confirm!==true)throw Error('UPDATE_CONFIRMATION_REQUIRED');
   return json(res,202,startJob(req.url.slice(5),body));
  }catch(error){const code=error.code??error.message;json(res,400,{ok:false,error:/^[A-Z_]+$/.test(code)?code:'OPERATION_FAILED'});}
 });
 server.requestTimeout=20000;server.headersTimeout=10000;return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config'||!path.isAbsolute(args[1]))throw Error();const c=read(args[1]);const port=c.controlPort??18786;if(!Number.isInteger(port)||port<1024||port>65535||port===c.port)throw Error();const server=createControlPanel({configPath:args[1]});server.on('error',()=>{console.error('Control panel could not start');process.exitCode=1;});server.listen(port,'127.0.0.1',()=>console.log(`Control panel: http://127.0.0.1:${port}`));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close();server.closeAllConnections();});}
 catch{console.error('Usage: node control-panel.mjs --config <absolute native-bridge.json path>');process.exitCode=1;}
}
