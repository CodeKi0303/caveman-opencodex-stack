// Shipped over SSH stdin; only Node built-ins are required on the target PC.
// Calls that PC's existing loopback control service. Never reads Codex auth.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : 'REMOTE_CLIENT_FAILED';
const cleanWarnings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && /^[a-z0-9_]{1,100}$/.test(item)).slice(0,50) : [];
const cleanCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function readLocal(port, route, {token, body, timeoutMs = 15000} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({host:'127.0.0.1', port, path:route, method:data ? 'POST' : 'GET',
      headers:{...(token ? {'x-control-token':token} : {}), ...(data ? {'content-type':'application/json','content-length':data.length} : {})},
      timeout:timeoutMs}, response => {
      let size=0; const chunks=[];
      response.on('data', chunk => { size+=chunk.length; if(size>2*1024*1024)response.destroy(Error('CONTROL_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      response.on('error', () => reject(Error('REMOTE_CONTROL_UNAVAILABLE')));
      response.on('end', () => resolve({status:response.statusCode, text:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('timeout', () => request.destroy(Error('REMOTE_CONTROL_TIMEOUT')));
    request.on('error', () => reject(Error('REMOTE_CONTROL_UNAVAILABLE')));
    request.end(data);
  });
}

function parseResponse(response) {
  let result;try{result=JSON.parse(response.text);}catch{fail('REMOTE_CONTROL_RESPONSE_INVALID');}
  if(response.status<200||response.status>=300||result?.ok!==true)fail(safeCode(result?.error));
  return result;
}

export function sanitizeRemoteStatus(result) {
  const settings=result.settings??{},bridge=result.bridge??{},catalog=result.catalog??{};
  let upstreamUrl;
  try{upstreamUrl=new URL(settings.upstreamUrl);if(!['http:','https:'].includes(upstreamUrl.protocol)||upstreamUrl.username||upstreamUrl.password||upstreamUrl.search||upstreamUrl.hash||!['/v1','/v1/'].includes(upstreamUrl.pathname))upstreamUrl=null;}catch{}
  return {ok:true,upstreamUrl:upstreamUrl?.href??null,compression:settings.compression!==false,
    clientAuthMode:['forward','server'].includes(settings.clientAuthMode)?settings.clientAuthMode:'unknown',
    bridge:{ok:bridge.ok===true,hotReload:bridge.hotReload===true},gateway:{ok:result.gateway?.ok===true},
    catalog:{count:cleanCount(catalog.count),totalCount:cleanCount(catalog.totalCount),hiddenCount:cleanCount(catalog.hiddenCount)},
    busy:result.busy===true,canApply:result.capabilities?.remoteClientManagement===1};
}

function sanitizeJob(action, result) {
  if(action==='sync')return {ok:result?.ok===true,changed:result?.changed===true||result?.catalogChanged===true,restartCodex:result?.restartCodex===true,warnings:cleanWarnings(result?.warnings)};
  return {ok:result?.ok===true,warnings:cleanWarnings(result?.warnings),
    catalog:{ok:result?.catalog?.ok===true,referenceMatches:result?.catalog?.referenceMatches===true},
    bridge:{ok:result?.bridge?.ok===true},mcp:{ok:result?.mcp?.ok===true,recoveryAvailable:result?.mcp?.recoveryAvailable===true}};
}

export function sanitizeRemoteResult(action, result) {
  if(!result||typeof result!=='object'||typeof result.ok!=='boolean')fail('REMOTE_RESPONSE_INVALID');
  if(result.ok===false)return {ok:false,error:safeCode(result.error),...(result.diagnostic?{diagnostic:sanitizeJob(action,result.diagnostic)}:{})};
  if(action==='sync'||action==='doctor')return sanitizeJob(action,result);
  // Filter SSH output through the same strict schema as the control API.
  return {...sanitizeRemoteStatus({settings:result,bridge:result.bridge,gateway:result.gateway,catalog:result.catalog,busy:result.busy,
    capabilities:{remoteClientManagement:result.canApply?1:0}}),...(action==='apply'?{applied:result.applied===true,restartCodex:result.restartCodex===true}:{})};
}

export async function runRemoteClientWorker(input, {request=readLocal, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), now=Date.now} = {}) {
  if(!input||!['status','apply','sync','doctor'].includes(input.action))fail('INVALID_REMOTE_ACTION');
  if(typeof input.configPath!=='string'||!path.isAbsolute(input.configPath)||path.basename(input.configPath)!=='native-bridge.json')fail('INVALID_REMOTE_CONFIG');
  let config;
  try{config=JSON.parse(fs.readFileSync(input.configPath,'utf8'));}catch{fail('REMOTE_CONFIG_UNREADABLE');}
  const port=config.controlPort??18786;
  if(!Number.isInteger(port)||port<1024||port>65535||port===config.port)fail('INVALID_REMOTE_CONTROL_PORT');
  const page=await request(port,'/');
  if(page.status!==200)fail('REMOTE_CONTROL_UNAVAILABLE');
  const token=/name="control-token" content="([a-f0-9]{64})"/.exec(page.text)?.[1];
  if(!token)fail('REMOTE_CONTROL_RESPONSE_INVALID');
  const getStatus=async()=>parseResponse(await request(port,'/api/status',{token}));
  const status=await getStatus();
  // Prevent a second user's control service on a different port from being
  // mistaken for the file supplied by the operator.
  if(status.settings?.bridgeUrl!==`http://127.0.0.1:${config.port}/v1`||status.settings?.upstreamUrl!==config.upstreamUrl)fail('REMOTE_CONTROL_CONFIG_MISMATCH');
  if(input.action==='status')return sanitizeRemoteStatus(status);
  if(status.busy)fail('REMOTE_CLIENT_BUSY');
  if(input.action==='apply') {
    if(status.capabilities?.remoteClientManagement!==1)fail('REMOTE_CONTROL_UPGRADE_REQUIRED');
    const value=input.settings;
    if(!value||typeof value.compression!=='boolean'||!['server','forward'].includes(value.clientAuthMode))fail('INVALID_REMOTE_SETTINGS');
    let upstream;
    try{upstream=new URL(value.upstreamUrl);}catch{fail('INVALID_REMOTE_SETTINGS');}
    if(!['http:','https:'].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash||!['/v1','/v1/'].includes(upstream.pathname))fail('INVALID_REMOTE_SETTINGS');
    if(typeof value.key!=='string'||value.key.length<32||value.key.length>4096||/[\r\n]/.test(value.key))fail('INVALID_REMOTE_KEY');
    // Intentionally omit management, port and all other PC-specific settings.
    parseResponse(await request(port,'/api/settings',{token,body:{upstreamUrl:value.upstreamUrl,key:value.key,compression:value.compression,clientAuthMode:value.clientAuthMode},timeoutMs:90000}));
    const after=await getStatus();
    upstream.pathname='/v1';
    if(after.settings?.upstreamUrl!==upstream.href||after.settings?.compression!==value.compression||after.settings?.clientAuthMode!==value.clientAuthMode)fail('REMOTE_SETTINGS_NOT_APPLIED');
    return {ok:true,applied:true,restartCodex:true,...sanitizeRemoteStatus(after)};
  }
  const started=parseResponse(await request(port,'/api/'+input.action,{token,body:{}}));
  const jobId=started.job?.id;
  if(typeof jobId!=='string'||!jobId)fail('REMOTE_JOB_INVALID');
  const deadline=now()+90000;
  while(now()<deadline) {
    const current=await getStatus(),job=current.job;
    if(job?.id!==jobId)fail('REMOTE_JOB_REPLACED');
    if(job.status==='succeeded')return sanitizeJob(input.action,job.result);
    if(job.status==='failed')return {ok:false,error:safeCode(job.error),...(job.result?{diagnostic:sanitizeJob(input.action,job.result)}:{})};
    await sleep(250);
  }
  fail('REMOTE_JOB_TIMEOUT');
}

// The SSH bootstrap invokes this explicitly after piping the module and input.
export async function remoteClientWorkerMain(input) {
  try {
    const [major,minor]=process.versions.node.split('.').map(Number);
    if(major<22||(major===22&&minor<13))fail('REMOTE_NODE_UPGRADE_REQUIRED');
    const result=await runRemoteClientWorker(input);
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.ok)process.exitCode=1;
  } catch(error) {
    process.stdout.write(JSON.stringify({ok:false,error:safeCode(error.code??error.message)})+'\n');
    process.exitCode=1;
  }
}
