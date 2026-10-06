import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runClient} from './client-lib.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function atomic(file,value){const tmp=file+'.tmp-'+randomUUID();try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function validUrl(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['/v1','/v1/'].includes(u.pathname))throw Error('INVALID_URL');u.pathname='/v1';return u.href;}
function validateManagement(value){
 if(value===null)return null;
 if(!value||typeof value.host!=='string'||!/^([a-z_][a-z0-9_-]*@)?[a-z0-9.-]+$/i.test(value.host)||value.host.startsWith('-')||
   !path.isAbsolute(value.keyFile??'')||typeof value.repo!=='string'||!/^\/[a-zA-Z0-9_./-]+$/.test(value.repo)||value.repo.split('/').includes('..'))throw Error('INVALID_SSH_SETTINGS');
 if(!fs.statSync(value.keyFile).isFile())throw Error('SSH_KEY_UNREADABLE');
 return {host:value.host,keyFile:value.keyFile,repo:value.repo};
}
export function remoteCommand(settings,action,args={}){
 const m=validateManagement(settings.management);
 if(!m)throw Error('SSH_NOT_CONFIGURED');
 if(m.host.split('@').at(-1).toLowerCase()!==new URL(settings.upstreamUrl).hostname.toLowerCase())throw Error('SSH_TARGET_MISMATCH');
 const source=fs.readFileSync(path.join(directory,'server-control.py')).toString('base64');
 return new Promise((resolve,reject)=>{
  const child=spawn('ssh',['-T','-i',m.keyFile,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',m.host,
   `python3 -c "import base64;exec(base64.b64decode('${source}'))"`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024)child.kill();});child.stderr.resume();
  const timer=setTimeout(()=>{child.kill();reject(Error('SSH_TIMEOUT'));},40*60*1000);
  child.on('error',()=>{clearTimeout(timer);reject(Error('SSH_UNAVAILABLE'));});
  child.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code!==0||!result.ok)throw Error(result.error||'SERVER_OPERATION_FAILED');resolve(result);}catch(error){reject(Error(/^[A-Z_]+$/.test(error.message)?error.message:'SERVER_OPERATION_FAILED'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({repo:m.repo,action,...args}));
 });
}
export function createControlPanel({configPath,fetchFn=fetch,client=runClient,remote=remoteCommand}={}){
 configPath=path.resolve(configPath);
 const home=path.dirname(path.dirname(configPath));
 const csrf=randomBytes(32).toString('hex');
 let job=null,busy=false;
 const settings=()=>read(configPath);
 const key=c=>fs.readFileSync(c.keyFile,'utf8').trim();
 const safeSettings=c=>({upstreamUrl:c.upstreamUrl,compression:c.compression!==false,keyConfigured:fs.existsSync(c.keyFile),bridgeUrl:`http://127.0.0.1:${c.port}/v1`,management:c.management??null});
 const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(value));
 async function gateway(c,suffix){const r=await fetchFn(c.upstreamUrl+suffix,{headers:{'x-caveman-gateway-key':key(c)},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(r.status===401?'GATEWAY_KEY_REJECTED':'GATEWAY_UNAVAILABLE');return r.json();}
 async function status(){const c=settings();let bridge={ok:false},gatewayState={ok:false};
  try{const r=await fetchFn(`http://127.0.0.1:${c.port}/healthz`,{signal:AbortSignal.timeout(2000)});const b=await r.json();bridge={ok:r.ok&&b.service==='caveman-native-bridge',compression:b.compression,hotReload:b.controlVersion===1};}catch{}
  try{const info=await gateway(c,'/stack-info');gatewayState={ok:true,compressionSwitch:info.capabilities?.compressionSwitch===true};}catch{}
  let catalog={count:0};try{const file=path.join(home,'opencodex-catalog.json'),data=read(file);catalog={count:data.models.length,modified:fs.statSync(file).mtime.toISOString()};}catch{}
  return {ok:true,settings:safeSettings(c),bridge,gateway:gatewayState,catalog,job,busy};
 }
 async function save(body){
  const before=settings(),next={...before};
  next.upstreamUrl=validUrl(body.upstreamUrl);
  if(typeof body.compression!=='boolean')throw Error('INVALID_COMPRESSION');next.compression=body.compression;
  if(body.management!==undefined)next.management=validateManagement(body.management);
  if(body.key!==undefined&&body.key!==''&&(typeof body.key!=='string'||body.key.length<32||body.key.length>4096||/[\r\n]/.test(body.key)))throw Error('INVALID_KEY');
  let newKey;
  try{
   if(body.key){newKey=path.join(path.dirname(configPath),'gateway-key-'+randomUUID());fs.writeFileSync(newKey,body.key,{mode:0o600,flag:'wx'});next.keyFile=newKey;}
   const info=await gateway(next,'/stack-info');if(!info.capabilities?.compressionSwitch)throw Error('SERVER_UPGRADE_REQUIRED');
   const b=await fetchFn(`http://127.0.0.1:${before.port}/healthz`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
   if(b.controlVersion!==1)throw Error('BRIDGE_UPGRADE_REQUIRED');
   const backup=path.join(path.dirname(configPath),'control-backups');fs.mkdirSync(backup,{recursive:true,mode:0o700});
   fs.copyFileSync(configPath,path.join(backup,'bridge-'+Date.now()+'.json'));
   atomic(configPath,next);
   try{await client(['reconfigure','--provider','openai','--url',next.upstreamUrl,'--key-file',next.keyFile,'--codex-home',home,'--bridge-url',`http://127.0.0.1:${next.port}/v1`]);}
   catch(error){atomic(configPath,before);throw error;}
   return {ok:true,message:'연결 설정을 저장했습니다. 새 요청부터 적용됩니다. Pod 주소·키를 바꿨다면 Codex를 재시작해 복구 MCP 설정도 반영하세요.'};
  }catch(error){if(newKey&&settings().keyFile!==newKey)fs.rmSync(newKey,{force:true});throw error;}
 }
 function startJob(action,body){
  busy=true;job={id:randomUUID(),action,status:'running',started:new Date().toISOString()};
  const c=settings();
  (async()=>{
   if(action==='sync'||action==='doctor'){
    const result=await client([action==='sync'?'sync':'doctor','--url',c.upstreamUrl,'--key-file',c.keyFile,'--codex-home',home]);
    job.result=action==='sync'?{ok:result.ok,changed:result.catalogChanged,restartCodex:result.restartCodex,warnings:result.warnings}:result;
    if(!result.ok)throw Error('DOCTOR_FAILED');
   }else{
    job.result=await remote(c,action==='check-update'?'check':action==='refresh-server-catalog'?'catalog':'update',action==='update'?{component:body.component,version:body.version}:{});
   }
   job.status='succeeded';
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
   if(req.method!=='POST'||!['/api/settings','/api/sync','/api/doctor','/api/check-update','/api/update','/api/refresh-server-catalog'].includes(req.url))return json(res,404,{error:'NOT_FOUND'});
   if(busy)return json(res,409,{error:'OPERATION_BUSY'});
   if(req.headers['content-type']!=='application/json')return json(res,415,{error:'JSON_REQUIRED'});
   let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return json(res,413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
   const body=JSON.parse(Buffer.concat(chunks).toString());
   if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_INPUT');
   if(req.url==='/api/settings'){busy=true;try{return json(res,200,await save(body));}finally{busy=false;}}
   if(req.url==='/api/update'&&(!['caveman','opencodex'].includes(body.component)||!/^\d+\.\d+\.\d+$/.test(body.version??'')))throw Error('INVALID_VERSION');
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
