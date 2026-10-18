import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {parseConfig, patchConfig, effectiveConfig, ConfigError, REMOVE, at} from './client-config.mjs';

export class ClientError extends Error {
  constructor(code,message) {super(message);this.code=code;}
}
const fail=(code,message)=>{throw new ClientError(code,message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>fs.existsSync(file)?fs.readFileSync(file):null;
const jsonRead=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const normalized=catalog=>JSON.stringify(catalog,null,2)+'\n';
const commands=['configure','reconfigure','sync','doctor','export'];

export function validateCatalog(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || !Array.isArray(value.models) || value.models.length===0)
    fail('INVALID_CATALOG','The server catalog is empty or invalid. Existing files were kept.');
  const names=new Set();
  for(const model of value.models) {
    if(!model || typeof model.slug!=='string' || !model.slug.trim() || typeof model.display_name!=='string' || !model.display_name.trim() || names.has(model.slug))
      fail('INVALID_CATALOG','The server catalog contains invalid or duplicate model entries. Existing files were kept.');
    names.add(model.slug);
  }
  return value;
}
function localCatalog(file) {try{return validateCatalog(jsonRead(file));}catch{return null;}}
function apiBase(value) {
  let url;
  try {url=new URL(value);}catch{fail('INVALID_URL','Expected an HTTP(S) API URL ending in /v1.');}
  url.pathname=url.pathname.replace(/\/+$/,'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/v1'))
    fail('INVALID_URL','Expected an HTTP(S) API URL ending in /v1, without credentials, query or fragment.');
  return url.toString().replace(/\/$/,'');
}
function bridgeBase(value) {
  const base=apiBase(value),url=new URL(base);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/v1')
    fail('INVALID_BRIDGE_URL','The native OpenAI bridge must use http://127.0.0.1:PORT/v1.');
  return base;
}
const mcpUrl=base=>base.slice(0,-3)+'/mcp';
function endpointEquals(actual,expected) {try{return apiBase(actual)===expected;}catch{return false;}}
function keyIn(headers) {
  if(!headers||typeof headers!=='object')return undefined;
  const pairs=Object.entries(headers).filter(([k])=>k.toLowerCase()==='x-caveman-gateway-key');
  return pairs.length===1?pairs[0][1]:undefined;
}
function hasGatewayEnvHeader(headers) {
  return !!headers&&typeof headers==='object'&&Object.keys(headers).some(name=>name.toLowerCase()==='x-caveman-gateway-key');
}
function connectionReport(config,base,key,providerOverride,bridgeUrl) {
  const effective=effectiveConfig(config), id=providerOverride??effective.provider;
  const provider=config.model_providers?.[id],mcp=config.mcp_servers?.caveman,warnings=[];
  if(id==='openai') {
    if(provider)warnings.push('reserved_openai_provider_override');
    if(!bridgeUrl||!endpointEquals(config.openai_base_url,bridgeUrl))warnings.push('openai_bridge_url_mismatch');
    if(process.env.OPENAI_BASE_URL&&!endpointEquals(process.env.OPENAI_BASE_URL,bridgeUrl))warnings.push('openai_base_url_environment_override');
  } else {
    if(!provider)warnings.push('selected_provider_not_configured');
    if(!endpointEquals(provider?.base_url,base))warnings.push('provider_url_mismatch');
    if(keyIn(provider?.http_headers)!==key)warnings.push('provider_gateway_key_mismatch');
    if(hasGatewayEnvHeader(provider?.env_http_headers))warnings.push('provider_gateway_env_header_conflict');
    if(provider?.wire_api!=='responses')warnings.push('provider_wire_api_mismatch');
    if(provider?.requires_openai_auth!==true)warnings.push('provider_auth_mode_mismatch');
    if(provider?.supports_websockets!==false)warnings.push('provider_websockets_not_disabled');
    if(provider?.env_key||provider?.experimental_bearer_token)warnings.push('provider_has_additional_auth_override');
  }
  const compression=(effective.profile?config.profiles?.[effective.profile]?.features?.enable_request_compression:undefined)??config.features?.enable_request_compression;
  if(compression!==false)warnings.push('request_compression_not_disabled');
  if(mcp?.url!==mcpUrl(base)||mcp?.command||mcp?.enabled===false)warnings.push('mcp_url_or_transport_mismatch');
  if(keyIn(mcp?.http_headers)!==key)warnings.push('mcp_gateway_key_mismatch');
  if(hasGatewayEnvHeader(mcp?.env_http_headers))warnings.push('mcp_gateway_env_header_conflict');
  if(providerOverride&&providerOverride!==effective.provider)warnings.push('updated_provider_is_not_selected');
  return {provider:id,selectedProvider:effective.provider,profile:effective.profile,warnings};
}

function configuredText(original,config,command,base,key,target,requestedProvider,bridgeUrl) {
  const effective=effectiveConfig(config);
  const id=requestedProvider??(command==='reconfigure'?effective.provider:'caveman_stack');
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))fail('INVALID_PROVIDER','Provider ID must contain only letters, digits, underscores or hyphens.');
  if(command==='reconfigure'&&id!=='openai'&&!config.model_providers?.[id])fail('PROVIDER_NOT_FOUND','The selected provider is not configured. Use configure for a new provider or specify --provider.');
  const changes=[],removePrefixes=[];
  const set=(p,value)=>changes.push({path:p,value});
  const catalogPath=effective.profile&&at(config,['profiles',effective.profile,'model_catalog_json'])!==undefined
    ?['profiles',effective.profile,'model_catalog_json']:['model_catalog_json'];
  set(catalogPath,target.replaceAll('\\','/'));
  if(command==='configure') {
    set(effective.profile?['profiles',effective.profile,'model_provider']:['model_provider'],id);
    if(id==='openai'&&effective.profile)set(['model_provider'],id);
  }
  if(command==='configure'||command==='reconfigure') {
    set(effective.profile&&at(config,['profiles',effective.profile,'features','enable_request_compression'])!==undefined
      ?['profiles',effective.profile,'features','enable_request_compression']:['features','enable_request_compression'],false);
    const p=['model_providers',id],m=['mcp_servers','caveman'];
    if(id==='openai') {
      set(['openai_base_url'],bridgeUrl);
      removePrefixes.push(p);
    } else {
      if(!config.model_providers?.[id]?.name)set([...p,'name'],'Caveman + OpenCodex');
      for(const [k,v] of Object.entries({base_url:base,wire_api:'responses',requires_openai_auth:true,supports_websockets:false}))set([...p,k],v);
    }
    for(const parent of id==='openai'?[m]:[p,m]) {
      for(const existing of Object.keys(at(config,[...parent,'http_headers'])??{}))
        if(existing.toLowerCase()==='x-caveman-gateway-key'&&existing!=='x-caveman-gateway-key')set([...parent,'http_headers',existing],REMOVE);
      set([...parent,'http_headers','x-caveman-gateway-key'],key);
      for(const existing of Object.keys(at(config,[...parent,'env_http_headers'])??{}))
        if(existing.toLowerCase()==='x-caveman-gateway-key')set([...parent,'env_http_headers',existing],REMOVE);
    }
    set([...m,'url'],mcpUrl(base));set([...m,'enabled'],true);
    for(const legacy of ['command','args','cwd','env_vars'])set([...m,legacy],REMOVE);
    removePrefixes.push([...m,'env']);
  }
  return {text:patchConfig(original,changes,removePrefixes),provider:id};
}

function atomic(file,bytes) {
  const temporary=file+'.tmp-'+randomUUID();
  try {fs.writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

// Only changed files are backed up and replaced. Detect a concurrent user edit
// before publishing, and retain previous bytes if a replacement fails.
function commitFiles(home,planned) {
  const changed=planned.filter(p=>p.before===null||!p.before.equals(Buffer.from(p.after)));
  if(!changed.length)return null;
  for(const p of changed) {
    const now=read(p.file);
    if((now===null)!==(p.before===null)||(now!==null&&!now.equals(p.before)))fail('CONCURRENT_EDIT','A client file changed during synchronization. Retry after the other edit finishes.');
  }
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const backup=path.join(home,'before-caveman-'+Date.now()+'-'+randomUUID().slice(0,8));
  fs.mkdirSync(backup,{mode:0o700});
  for(const p of changed)if(p.before!==null)fs.writeFileSync(path.join(backup,path.basename(p.file)),p.before,{mode:0o600});
  fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({files:changed.map(p=>p.file),existed:changed.map(p=>p.before!==null)}),{mode:0o600});
  const written=[];
  try {
    for(const p of changed) {atomic(p.file,p.after);written.push(p);}
  } catch {
    let restored=true;
    for(const p of written.reverse())try {if(p.before===null)fs.unlinkSync(p.file);else atomic(p.file,p.before);}catch{restored=false;}
    fail(restored?'WRITE_FAILED':'ROLLBACK_FAILED',restored?'Updating client files failed; previous files were restored.':'Updating client files failed. Restore the protected before-caveman backup before retrying.');
  }
  return backup;
}

async function catalogRequest(base,key,auth,local,metadata,fetchFn,exportMode) {
  const headers={'x-caveman-gateway-key':key};
  if(auth?.tokens?.access_token){headers.Authorization='Bearer '+auth.tokens.access_token;headers['chatgpt-account-id']=auth.tokens.account_id||'';}
  else if(auth?.OPENAI_API_KEY)headers.Authorization='Bearer '+auth.OPENAI_API_KEY;
  if(!exportMode&&local&&metadata?.url===base&&typeof metadata.etag==='string'&&metadata.etag.length<1024&&metadata.catalogSha256===digest(normalized(local)))headers['if-none-match']=metadata.etag;
  const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).dependencies['@openai/codex'];
  const endpoint=base+(exportMode?'/models?client_version='+encodeURIComponent(version):'/catalog');
  for(let attempt=0;attempt<2;attempt++) {
    let response;
    try {response=await fetchFn(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});}
    catch {fail('CATALOG_UNREACHABLE','Catalog request failed. Check the endpoint, network and certificate trust. Existing files were kept.');}
    if(response.status===304) {
      if(local)return {catalog:local,etag:response.headers.get('etag')??metadata?.etag??null,notModified:true};
      delete headers['if-none-match'];continue;
    }
    if(!response.ok)fail('CATALOG_HTTP_'+response.status,'Catalog request failed (HTTP '+response.status+'). Existing files were kept.');
    let body;
    try {body=await response.json();}catch{fail('INVALID_CATALOG','The server did not return a JSON catalog. Existing files were kept.');}
    return {catalog:validateCatalog(body),etag:response.headers.get('etag'),notModified:false};
  }
  fail('INVALID_CATALOG_304','The server returned no catalog while the local copy is missing or invalid. Existing files were kept.');
}

function authMetadata(file) {
  const auth=jsonRead(file);
  if(!auth)return {exists:fs.existsSync(file),usable:false,status:fs.existsSync(file)?'invalid':'missing'};
  if(typeof auth.OPENAI_API_KEY==='string'&&auth.OPENAI_API_KEY)return {exists:true,usable:true,status:'api_key_present'};
  const token=auth.tokens?.access_token;
  if(typeof token!=='string'||!token)return {exists:true,usable:false,status:'access_token_missing'};
  let expiration=null;
  try {const payload=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());if(Number.isFinite(payload.exp))expiration=new Date(payload.exp*1000).toISOString();}catch{}
  const expired=expiration!==null&&Date.parse(expiration)<=Date.now();
  return {exists:true,usable:!expired,status:expired?'access_token_expired':'access_token_present',accessTokenExpiresAt:expiration,refreshTokenPresent:typeof auth.tokens?.refresh_token==='string'&&!!auth.tokens.refresh_token};
}

async function inspectMcp(url,key,fetchFn) {
  let client;
  try {
    const [{Client},{StreamableHTTPClientTransport}]=await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
    client=new Client({name:'caveman-stack-doctor',version:'0.2.0'},{capabilities:{}});
    const transport=new StreamableHTTPClientTransport(new URL(url),{
      requestInit:{headers:{'x-caveman-gateway-key':key},redirect:'error'},
      reconnectionOptions:{maxRetries:0,initialReconnectionDelay:100,maxReconnectionDelay:100,reconnectionDelayGrowFactor:1},
      fetch:(input,init={})=>fetchFn(input,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})});
    await client.connect(transport,{timeout:15000});
    const listed=await client.listTools({}, {timeout:15000});
    const tools=listed.tools.map(t=>t.name),recovery=tools.includes('caveman_retrieve');
    return {ok:recovery,initialized:true,tools,recoveryAvailable:recovery};
  } catch {return {ok:false,initialized:false,error:'MCP_UNAVAILABLE'};}
  finally {try{await client?.close();}catch{}}
}

async function inspectBridge(url,base,fetchFn) {
  if(!url)return {ok:false,error:'BRIDGE_URL_MISSING'};
  try {
    const response=await fetchFn(url.slice(0,-3)+'/healthz',{headers:{},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)return {ok:false,url,error:'BRIDGE_HTTP_'+response.status};
    const health=await response.json();
    if(health.service!=='caveman-native-bridge'||health.ok!==true||health.status!=='ok')return {ok:false,url,error:'BRIDGE_HEALTH_INVALID'};
    if(!endpointEquals(health.upstream,base))return {ok:false,url,error:'BRIDGE_UPSTREAM_MISMATCH'};
    const catalog=await fetchFn(url+'/catalog',{headers:{},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!catalog.ok)return {ok:false,url,upstreamMatches:true,error:'BRIDGE_CATALOG_HTTP_'+catalog.status};
    let models;
    try {models=validateCatalog(await catalog.json()).models.length;}
    catch {return {ok:false,url,upstreamMatches:true,error:'BRIDGE_CATALOG_INVALID'};}
    return {ok:true,url,upstreamMatches:true,catalogAvailable:true,models};
  } catch {return {ok:false,url,error:'BRIDGE_UNREACHABLE'};}
}

function parseArgs(argv) {
  const [command,...args]=argv;
  if(command==='--help'||command==='help')return {help:true};
  if(!commands.includes(command))fail('USAGE','Usage: client.mjs configure|reconfigure|sync|doctor|export --url http(s)://host:port/v1 --key-file FILE [--codex-home DIR] [--provider ID] [--bridge-url http://127.0.0.1:PORT/v1] [--output FILE] [--auth-file FILE]');
  const allowed=new Set(['url','key-file','codex-home','provider','bridge-url','output','auth-file']),opts={};
  for(let i=0;i<args.length;i+=2) {
    const name=args[i]?.slice(2);
    if(!args[i]?.startsWith('--')||!allowed.has(name)||!args[i+1]||args[i+1].startsWith('--')||name in opts)fail('USAGE','Expected supported --name value options, with no duplicates.');
    opts[name]=args[i+1];
  }
  if(!opts['key-file'])fail('USAGE','--key-file is required.');
  return {command,opts};
}

export async function runClient(argv,{fetchFn=fetch}={}) {
  try {return await execute(argv,fetchFn);}
  catch(error) {if(error instanceof ConfigError)fail('CONFIG_MERGE_REQUIRED',error.message);throw error;}
}
async function execute(argv,fetchFn) {
  const parsed=parseArgs(argv);
  if(parsed.help)return {ok:true,commands,options:['--url','--key-file','--codex-home','--provider','--bridge-url','--output','--auth-file'],sync:'Catalog and ETag metadata only; unchanged catalog and metadata produce no writes or backups.',reconfigure:'Updates one existing provider (selected provider by default) and HTTP MCP; does not switch another selected provider.',openai:'Use configure --provider openai --bridge-url http://127.0.0.1:PORT/v1 after starting the native bridge. --url remains the authenticated remote gateway for catalog and MCP.'};
  const {command,opts}=parsed,base=apiBase(opts.url||'http://127.0.0.1:18787/v1');
  let key;
  try {key=fs.readFileSync(opts['key-file'],'utf8').trim();}catch{fail('KEY_FILE_UNREADABLE','Cannot read the gateway key file.');}
  if(key.length<32||key.length>4096||/[\r\n]/.test(key))fail('INVALID_GATEWAY_KEY','The gateway key file is invalid.');
  const home=path.resolve(opts['codex-home']||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
  const cfgFile=path.join(home,'config.toml'),catalogFile=path.join(home,'opencodex-catalog.json'),cacheFile=path.join(home,'models_cache.json'),metaFile=path.join(home,'caveman-catalog-sync.json');
  const cfgBefore=read(cfgFile),catalogBefore=read(catalogFile),cacheBefore=read(cacheFile),metaBefore=read(metaFile);
  const config=command==='export'?{}:parseConfig(cfgBefore?.toString('utf8')??''),local=localCatalog(catalogFile),metadata=jsonRead(metaFile);
  // Re-running the documented setup must not undo a native Remote migration.
  // Fresh installs without a bridge still retain the legacy explicit-header mode.
  const preserveNative=command==='configure'&&effectiveConfig(config).provider==='openai'&&Boolean(config.openai_base_url);
  const requestedProvider=opts.provider??(command==='configure'&&(opts['bridge-url']||preserveNative)?'openai':undefined);
  const provider=requestedProvider??(command==='configure'?'caveman_stack':effectiveConfig(config).provider);
  let bridgeUrl;
  if(opts['bridge-url']) {
    if(provider!=='openai')fail('BRIDGE_PROVIDER_MISMATCH','--bridge-url requires the built-in openai provider.');
    bridgeUrl=bridgeBase(opts['bridge-url']);
  } else if(provider==='openai'&&config.openai_base_url) {
    try {bridgeUrl=bridgeBase(config.openai_base_url);}catch(error) {if(command==='configure'||command==='reconfigure')throw error;}
  }
  if((command==='configure'||command==='reconfigure')&&provider==='openai'&&!bridgeUrl)
    fail('BRIDGE_URL_MISSING','--bridge-url is required to configure the built-in openai provider. Start the native bridge before changing the client.');
  const report=connectionReport(config,base,key,requestedProvider,bridgeUrl);
  let auth;
  if(opts['auth-file']) {auth=jsonRead(opts['auth-file']);if(!auth)fail('AUTH_FILE_INVALID','The supplied auth file is unreadable or invalid.');}
  if(command==='doctor') {
    let remote;
    try {const result=await catalogRequest(base,key,undefined,local,metadata,fetchFn,false);remote={ok:true,models:result.catalog.models.length,notModified:result.notModified};}
    catch(error){remote={ok:false,error:error instanceof ClientError?error.code:'CATALOG_UNAVAILABLE'};}
    const mcp=await inspectMcp(mcpUrl(base),key,fetchFn),authState=authMetadata(opts['auth-file']||path.join(home,'auth.json'));
    const bridge=report.provider==='openai'?await inspectBridge(bridgeUrl,base,fetchFn):undefined;
    const catalogReference=effectiveConfig(config).catalog;
    const refMatches=typeof catalogReference==='string'&&path.resolve(home,catalogReference)===catalogFile;
    const warnings=[...report.warnings];
    if(!local)warnings.push('local_catalog_invalid_or_missing');
    if(!refMatches)warnings.push('catalog_reference_mismatch');
    if(!authState.usable)warnings.push(authState.status);
    return {ok:warnings.length===0&&remote.ok&&mcp.ok&&(!bridge||bridge.ok),command,provider:report.provider,selectedProvider:report.selectedProvider,profile:report.profile,warnings,catalog:{localValid:!!local,referenceMatches:refMatches,...remote},auth:authState,mcp,bridge,restartNotice:'Existing Codex processes or resumed chats may retain old provider settings. This command does not restart them.'};
  }
  let configured=null;
  if(command==='configure'||command==='reconfigure') {
    configured=configuredText(cfgBefore?.toString('utf8')??'',config,command,base,key,catalogFile,requestedProvider,bridgeUrl);
    if(configured.provider==='openai') {
      const bridge=await inspectBridge(bridgeUrl,base,fetchFn);
      if(!bridge.ok)fail(bridge.error,'The native OpenAI bridge is not ready or targets another gateway. Start the matching bridge before changing the client. Existing files were kept.');
    }
  }
  const fetched=await catalogRequest(base,key,auth,local,metadata,fetchFn,command==='export');
  const data=normalized(fetched.catalog),catalogChanged=!local||normalized(local)!==data;
  if(command==='export') {
    const output=path.resolve(opts.output||'/state/catalog/models.json'),before=read(output),changed=before===null||!before.equals(Buffer.from(data));
    if(changed){fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});atomic(output,data);}
    return {ok:true,command,changed,catalog:output,models:fetched.catalog.models.filter(m=>m.visibility==='list').map(m=>m.slug)};
  }
  const metaAfter=JSON.stringify({url:base,etag:fetched.etag,catalogSha256:digest(data)})+'\n';
  const planned=[{file:metaFile,before:metaBefore,after:metaAfter}];
  if(configured) {
    const settingsFile=path.join(home,'caveman-client.json');
    planned.push({file:settingsFile,before:read(settingsFile),after:JSON.stringify({version:1,
      url:base,keyFile:path.resolve(opts['key-file']),codexHome:home,node:process.execPath,
      ...(configured.provider==='openai'?{provider:'openai',bridgeUrl}:{} )},null,2)+'\n'});
  }
  if(catalogChanged) {
    planned.push({file:catalogFile,before:catalogBefore,after:data},
      {file:cacheFile,before:cacheBefore,after:JSON.stringify({fetched_at:'2000-01-01T00:00:00Z',client_version:'0.0.0',models:fetched.catalog.models})+'\n'});
  }
  if(command==='sync'&&!catalogChanged) {
    const backup=commitFiles(home,planned);
    return {ok:true,command,changed:backup!==null,catalogChanged:false,notModified:fetched.notModified,catalog:catalogFile,backup,warnings:report.warnings,restartCodex:false};
  }
  // Backward-compatible first sync installs only the local catalog reference.
  // It never changes provider endpoints, gateway headers, MCP or credentials.
  const nextConfig=configured?.text??configuredText(cfgBefore?.toString('utf8')??'',config,'sync',base,key,catalogFile,requestedProvider,bridgeUrl).text;
  planned.push({file:cfgFile,before:cfgBefore,after:nextConfig});
  const backup=commitFiles(home,planned),afterReport=connectionReport(parseConfig(nextConfig),base,key,configured?.provider??requestedProvider,bridgeUrl);
  return {ok:true,command,changed:backup!==null,catalogChanged,catalog:catalogFile,provider:configured?.provider??report.provider,selectedProvider:afterReport.selectedProvider,mcp:command==='sync'?undefined:mcpUrl(base),backup,warnings:afterReport.warnings,restartCodex:catalogChanged||nextConfig!==(cfgBefore?.toString('utf8')??'')};
}
