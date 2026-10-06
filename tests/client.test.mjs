import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {runClient} from '../scripts/client-lib.mjs';
import {parseConfig,patchConfig,REMOVE} from '../scripts/client-config.mjs';
import {createNativeBridge} from '../src/native-bridge.mjs';

const oldKey='old-fixture-credential-'.repeat(3),newKey='new-fixture-credential-'.repeat(3);
const catalog={models:[{slug:'fixture',display_name:'Fixture',visibility:'list'}]};
const encode=value=>JSON.stringify(value,null,2)+'\n';
function fixture(t,config='') {
  const tmp=fs.realpathSync(os.tmpdir()),home=fs.mkdtempSync(path.join(tmp,'caveman-client-'));
  t.after(()=>{assert(path.resolve(home).startsWith(tmp+path.sep+'caveman-client-'));fs.rmSync(home,{recursive:true,force:true});});
  fs.writeFileSync(path.join(home,'config.toml'),config);fs.writeFileSync(path.join(home,'key'),oldKey);
  const state={catalog:structuredClone(catalog),etag:'"fixture-v1"',requests:[],force304:0,status:200};
  const fetchFn=async (url,opts)=>{
    state.requests.push({url:String(url),headers:{...opts.headers}});
    if(state.networkError)throw new Error(oldKey+' must not be printed');
    if(String(url).endsWith('/healthz')) {
      if(state.bridgeError)throw new Error(oldKey+' must not be printed');
      return Response.json(state.bridgeHealth??{service:'caveman-native-bridge',status:'ok',ok:true,upstream:'http://127.0.0.1:18787/v1'});
    }
    if(state.force304>0){state.force304--;return new Response(null,{status:304,headers:{etag:state.etag}});}
    if(state.status!==200)return new Response(oldKey,{status:state.status});
    if(opts.headers['if-none-match']===state.etag)return new Response(null,{status:304,headers:{etag:state.etag}});
    return new Response(JSON.stringify(state.catalog),{headers:{etag:state.etag,'content-type':'application/json'}});
  };
  const run=(command,...extra)=>runClient([command,'--url','http://127.0.0.1:18787/v1','--key-file',path.join(home,'key'),'--codex-home',home,...extra],{fetchFn});
  const configValue=()=>parseConfig(fs.readFileSync(path.join(home,'config.toml'),'utf8'));
  const snapshot=()=>Object.fromEntries(fs.readdirSync(home).sort().map(name=>{
    const filename=path.join(home,name),stat=fs.statSync(filename);
    return [name,{mtime:stat.mtimeMs,contents:stat.isFile()?fs.readFileSync(filename).toString('base64'):null}];
  }));
  return {home,state,run,configValue,snapshot};
}

test('configure installs one provider and HTTP recovery MCP, disables request compression',async t=>{
  const f=fixture(t,'# retain this comment\n[features]\nexample = true\n');
  const result=await f.run('configure'),config=f.configValue();
  assert.equal(result.ok,true);assert.deepEqual(result.warnings,[]);
  assert.equal(config.model_provider,'caveman_stack');
  assert.equal(config.model_catalog_json,path.join(f.home,'opencodex-catalog.json').replaceAll('\\','/'));
  assert.deepEqual(config.model_providers.caveman_stack,{name:'Caveman + OpenCodex',base_url:'http://127.0.0.1:18787/v1',wire_api:'responses',requires_openai_auth:true,supports_websockets:false,http_headers:{'x-caveman-gateway-key':oldKey}});
  assert.deepEqual(config.mcp_servers.caveman,{url:'http://127.0.0.1:18787/mcp',enabled:true,http_headers:{'x-caveman-gateway-key':oldKey}});
  assert.deepEqual(config.features,{example:true,enable_request_compression:false});
  assert(fs.readFileSync(path.join(f.home,'config.toml'),'utf8').includes('# retain this comment'));
  assert.equal(fs.existsSync(path.join(f.home,'auth.json')),false);
});

test('built-in openai configuration uses healthy local bridge while catalog, MCP and sync metadata keep the authenticated remote gateway',async t=>{
  const f=fixture(t,'# keep my settings\nmodel_provider = "caveman_lan"\n[model_providers.caveman_lan]\nname = "Legacy"\nbase_url = "http://old/v1"\n');
  const legacy=f.configValue().model_providers.caveman_lan;
  const result=await f.run('configure','--provider','openai','--bridge-url','http://127.0.0.1:18788/v1'),config=f.configValue();
  assert.equal(result.ok,true);assert.equal(result.provider,'openai');assert.deepEqual(result.warnings,[]);
  assert.equal(config.model_provider,'openai');assert.equal(config.openai_base_url,'http://127.0.0.1:18788/v1');
  assert.equal(config.model_providers.openai,undefined);assert.deepEqual(config.model_providers.caveman_lan,legacy);
  assert.equal(config.features.enable_request_compression,false);
  assert.equal(config.mcp_servers.caveman.url,'http://127.0.0.1:18787/mcp');
  assert.equal(config.mcp_servers.caveman.http_headers['x-caveman-gateway-key'],oldKey);
  const settings=JSON.parse(fs.readFileSync(path.join(f.home,'caveman-client.json')));
  assert.equal(settings.provider,'openai');assert.equal(settings.bridgeUrl,'http://127.0.0.1:18788/v1');
  assert.equal(settings.url,'http://127.0.0.1:18787/v1');assert.equal(settings.keyFile,path.join(f.home,'key'));
  const health=f.state.requests.find(r=>r.url.endsWith('/healthz'));
  assert.deepEqual(health.headers,{});assert.equal(f.state.requests.at(-1).headers['x-caveman-gateway-key'],oldKey);
  const before=f.snapshot(),sync=await f.run('sync');
  assert.equal(sync.changed,false);assert.deepEqual(sync.warnings,[]);assert.deepEqual(f.snapshot(),before);
});

test('repeated configure preserves an existing native bridge and fails closed if it stops',async t=>{
  const f=fixture(t);
  await f.run('configure','--provider','openai','--bridge-url','http://127.0.0.1:18788/v1');
  const before=f.snapshot();
  const repeated=await f.run('configure');
  assert.equal(repeated.provider,'openai');
  assert.equal(repeated.changed,false);
  assert.deepEqual(f.snapshot(),before);
  f.state.bridgeError=true;
  await assert.rejects(f.run('configure'),{code:'BRIDGE_UNREACHABLE'});
  assert.deepEqual(f.snapshot(),before);
  // An explicit provider selection remains available for intentional changes.
  assert.equal((await f.run('configure','--provider','caveman_stack')).provider,'caveman_stack');
});

test('explicit bridge selects builtin openai in root and active profile and removes reserved table without removing aliases',async t=>{
  const f=fixture(t,'profile = "work"\nmodel_provider = "root"\nmodel_providers = { openai = { base_url = "http://old/v1", http_headers = { Authorization = "legacy-secret" } }, old = { name = "keep" } }\n[profiles.work]\nmodel_provider = "caveman_lan"\nmodel = "keep-model"\n');
  const result=await f.run('configure','--bridge-url','http://127.0.0.1:18788/v1'),config=f.configValue();
  assert.equal(result.selectedProvider,'openai');assert.equal(config.model_provider,'openai');
  assert.equal(config.profiles.work.model_provider,'openai');assert.equal(config.profiles.work.model,'keep-model');
  assert.equal(config.model_providers.openai,undefined);assert.deepEqual(config.model_providers.old,{name:'keep'});
});

test('reconfigure built-in openai requires no custom provider table and keeps the current selection',async t=>{
  const f=fixture(t,'model_provider = "other"\nopenai_base_url = "http://127.0.0.1:18788/v1"\n[model_providers.other]\nname = "keep"\n');
  const result=await f.run('reconfigure','--provider','openai'),config=f.configValue();
  assert.equal(config.model_provider,'other');assert.equal(config.model_providers.openai,undefined);
  assert.deepEqual(config.model_providers.other,{name:'keep'});
  assert(result.warnings.includes('updated_provider_is_not_selected'));
});

test('built-in configuration refuses missing, remote, unavailable and incorrectly routed bridges without changing files',async t=>{
  const f=fixture(t,'model_provider = "caveman_lan"\n'),before=f.snapshot();
  await assert.rejects(f.run('configure','--provider','openai'),{code:'BRIDGE_URL_MISSING'});
  await assert.rejects(f.run('configure','--provider','openai','--bridge-url','http://remote.example/v1'),{code:'INVALID_BRIDGE_URL'});
  await assert.rejects(f.run('configure','--provider','caveman_lan','--bridge-url','http://127.0.0.1:18788/v1'),{code:'BRIDGE_PROVIDER_MISMATCH'});
  f.state.bridgeError=true;
  await assert.rejects(f.run('configure','--provider','openai','--bridge-url','http://127.0.0.1:18788/v1'),{code:'BRIDGE_UNREACHABLE'});
  f.state.bridgeError=false;f.state.bridgeHealth={service:'caveman-native-bridge',status:'ok',ok:true,upstream:'http://wrong:18787/v1'};
  await assert.rejects(f.run('configure','--provider','openai','--bridge-url','http://127.0.0.1:18788/v1'),{code:'BRIDGE_UPSTREAM_MISMATCH'});
  f.state.bridgeHealth={ok:true};
  await assert.rejects(f.run('configure','--provider','openai','--bridge-url','http://127.0.0.1:18788/v1'),{code:'BRIDGE_HEALTH_INVALID'});
  assert.deepEqual(f.snapshot(),before);
});

test('reconfigure rotates inline headers in the selected legacy provider and migrates SSH MCP',async t=>{
  const config=`# existing root\nmodel_provider = "caveman_lan"\nnotes = '''multiline\n[not_a_table]\nkeep = "as text"\n'''\n[model_providers.caveman_lan]\nname = "Keep my label"\nbase_url = "http://old:8787/v1" # update destination\nhttp_headers = { X-Caveman-Gateway-Key = "${oldKey}", X-Other = "preserved" } # header annotation\n[model_providers.unrelated]\nname = "Other"\nbase_url = "http://other:9999/v1"\nhttp_headers = { Authorization = "other-secret" }\n[mcp_servers.caveman]\ncommand = "ssh"\nargs = ["old", "caveman", "mcp"]\ncwd = "/old"\nenv_vars = ["OLD"]\nhttp_headers = { x-caveman-gateway-key = "${oldKey}", Other = "keep" }\n[mcp_servers.caveman.env]\nOLD = "unused"\n[mcp_servers.other]\ncommand = "untouched"\n[features]\nexample = true\n`;
  const f=fixture(t,config),unrelated=f.configValue().model_providers.unrelated;
  fs.writeFileSync(path.join(f.home,'key'),newKey);
  const result=await f.run('reconfigure'),after=f.configValue(),text=fs.readFileSync(path.join(f.home,'config.toml'),'utf8');
  assert.equal(result.provider,'caveman_lan');assert.equal(after.model_provider,'caveman_lan');
  assert.deepEqual(after.model_providers.unrelated,unrelated);assert.equal(after.model_providers.caveman_lan.name,'Keep my label');
  assert.deepEqual(after.model_providers.caveman_lan.http_headers,{'X-Other':'preserved','x-caveman-gateway-key':newKey});
  assert.equal(after.mcp_servers.caveman.http_headers['x-caveman-gateway-key'],newKey);
  for(const field of ['command','args','cwd','env_vars','env'])assert.equal(after.mcp_servers.caveman[field],undefined);
  assert.deepEqual(after.mcp_servers.other,{command:'untouched'});
  assert(text.includes("notes = '''multiline\n[not_a_table]\nkeep = \"as text\"\n'''"));
  assert(text.includes('# header annotation'));assert(text.includes('# update destination'));
  assert(!JSON.stringify(result).includes(oldKey));assert(!JSON.stringify(result).includes(newKey));
});

test('explicit provider reconfiguration changes only that provider and does not switch an active profile',async t=>{
  const f=fixture(t,'profile = "work"\nmodel_provider = "root"\n[profiles.work]\nmodel_provider = "caveman_subpc"\n[profiles.work.features]\nenable_request_compression = true\nkeep = true\n[model_providers.caveman_subpc]\nname = "Selected"\nbase_url = "http://old/v1"\n[model_providers.caveman]\nname = "Other target"\nbase_url = "http://old/v1"\n');
  const previous=f.configValue().model_providers.caveman_subpc;
  const result=await f.run('reconfigure','--provider','caveman'),after=f.configValue();
  assert.equal(after.profiles.work.model_provider,'caveman_subpc');assert.equal(after.model_provider,'root');
  assert.deepEqual(after.profiles.work.features,{enable_request_compression:false,keep:true});
  assert.deepEqual(after.model_providers.caveman_subpc,previous);
  assert.equal(after.model_providers.caveman.base_url,'http://127.0.0.1:18787/v1');
  assert(result.warnings.includes('updated_provider_is_not_selected'));
});

test('sync with matching ETag changes no bytes, mtimes, cache timestamp or backups',async t=>{
  const f=fixture(t);await f.run('configure');const before=f.snapshot();
  const result=await f.run('sync');
  assert.equal(result.changed,false);assert.equal(result.notModified,true);assert.equal(result.restartCodex,false);
  assert.equal(f.state.requests.at(-1).headers['if-none-match'],'"fixture-v1"');
  assert.deepEqual(f.snapshot(),before);
});

test('existing catalog acquires ETag metadata once without rewriting config, catalog or cache',async t=>{
  const f=fixture(t);await f.run('configure');fs.unlinkSync(path.join(f.home,'caveman-catalog-sync.json'));
  const before=f.snapshot();const migration=await f.run('sync'),after=f.snapshot();
  assert.equal(migration.catalogChanged,false);assert.equal(migration.changed,true);assert.equal(migration.restartCodex,false);
  for(const name of ['config.toml','opencodex-catalog.json','models_cache.json'])assert.deepEqual(after[name],before[name]);
  assert.equal((await f.run('sync')).changed,false);assert.deepEqual(f.snapshot(),after);
  f.state.etag='"same-content-new-tag"';const etagUpdate=await f.run('sync');
  assert.equal(etagUpdate.changed,true);assert.equal(etagUpdate.catalogChanged,false);assert.equal(etagUpdate.restartCodex,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'caveman-catalog-sync.json'))).etag,f.state.etag);
});

test('corrupt local catalog with unsolicited 304 is refetched unconditionally',async t=>{
  const f=fixture(t);await f.run('configure');fs.writeFileSync(path.join(f.home,'opencodex-catalog.json'),'{corrupt');
  f.state.force304=1;const start=f.state.requests.length,result=await f.run('sync');
  assert.equal(result.catalogChanged,true);assert.equal(f.state.requests.length-start,2);
  assert(f.state.requests.slice(start).every(r=>r.headers['if-none-match']===undefined));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home,'opencodex-catalog.json'))),catalog);
});

test('validation, HTTP, and network failures retain all last-good client files',async t=>{
  const f=fixture(t);await f.run('configure');const before=f.snapshot();
  f.state.etag='"changed"';f.state.catalog={models:[{slug:'duplicate',display_name:'One'},{slug:'duplicate',display_name:'Two'}]};
  await assert.rejects(f.run('sync'),{code:'INVALID_CATALOG'});assert.deepEqual(f.snapshot(),before);
  f.state.status=503;await assert.rejects(f.run('sync'),{code:'CATALOG_HTTP_503'});assert.deepEqual(f.snapshot(),before);
  f.state.networkError=true;await assert.rejects(f.run('sync'),error=>error.code==='CATALOG_UNREACHABLE'&&!error.message.includes(oldKey));assert.deepEqual(f.snapshot(),before);
});

test('sync warns about key mismatches without rewriting provider or printing credentials',async t=>{
  const f=fixture(t);await f.run('configure');fs.writeFileSync(path.join(f.home,'key'),newKey);
  const before=f.snapshot(),result=await f.run('sync');
  assert(result.warnings.includes('provider_gateway_key_mismatch'));assert(result.warnings.includes('mcp_gateway_key_mismatch'));
  assert(!JSON.stringify(result).includes(newKey));assert(!JSON.stringify(result).includes(oldKey));
  assert.deepEqual(f.snapshot(),before);
});

for(const command of ['configure','reconfigure'])test(command+' removes only conflicting dynamic gateway headers from provider and MCP',async t=>{
  const f=fixture(t);await f.run('configure');
  const cfgFile=path.join(f.home,'config.toml');
  fs.writeFileSync(cfgFile,patchConfig(fs.readFileSync(cfgFile,'utf8'),[
    {path:['model_providers','caveman_stack','env_http_headers'],value:{'x-caveman-gateway-key':'STALE_KEY','X-CAVEMAN-GATEWAY-KEY':'STALE_DUPLICATE','X-Other':'KEEP_PROVIDER_ENV'}},
    {path:['mcp_servers','caveman','env_http_headers','X-Caveman-Gateway-Key'],value:'STALE_MCP_KEY'},
    {path:['mcp_servers','caveman','env_http_headers','X-Other'],value:'KEEP_MCP_ENV'},
    {path:['model_providers','unselected','env_http_headers'],value:{'x-caveman-gateway-key':'KEEP_UNSELECTED'}}
  ]));
  const before=f.snapshot(),sync=await f.run('sync');
  assert(sync.warnings.includes('provider_gateway_env_header_conflict'));
  assert(sync.warnings.includes('mcp_gateway_env_header_conflict'));
  assert.deepEqual(f.snapshot(),before);assert(!JSON.stringify(sync).includes('STALE_'));
  const result=await f.run(command),after=f.configValue();
  assert.deepEqual(after.model_providers.caveman_stack.env_http_headers,{'X-Other':'KEEP_PROVIDER_ENV'});
  assert.deepEqual(after.mcp_servers.caveman.env_http_headers,{'X-Other':'KEEP_MCP_ENV'});
  assert.deepEqual(after.model_providers.unselected.env_http_headers,{'x-caveman-gateway-key':'KEEP_UNSELECTED'});
  assert.equal(after.model_providers.caveman_stack.http_headers['x-caveman-gateway-key'],oldKey);
  assert.equal(after.mcp_servers.caveman.http_headers['x-caveman-gateway-key'],oldKey);
  assert(!result.warnings.includes('provider_gateway_env_header_conflict'));
  assert(!result.warnings.includes('mcp_gateway_env_header_conflict'));
});

test('inline TOML parents support nested changes and removals while preserving sibling values',()=>{
  const input='features = { enable_request_compression = true, keep = true } # flags\nmcp_servers = { caveman = { command = "ssh", env = { SECRET = "unused" }, http_headers = { Old = "keep" } }, other = { command = "other" } }\n';
  const result=patchConfig(input,[{path:['features','enable_request_compression'],value:false},{path:['mcp_servers','caveman','command'],value:REMOVE},{path:['mcp_servers','caveman','url'],value:'http://host/mcp'},{path:['mcp_servers','caveman','http_headers','x-caveman-gateway-key'],value:oldKey}],[['mcp_servers','caveman','env']]);
  const parsed=parseConfig(result);
  assert.deepEqual(parsed.features,{enable_request_compression:false,keep:true});assert(result.includes('# flags'));
  assert.equal(parsed.mcp_servers.caveman.command,undefined);assert.equal(parsed.mcp_servers.caveman.env,undefined);
  assert.equal(parsed.mcp_servers.other.command,'other');assert.equal(parsed.mcp_servers.caveman.http_headers.Old,'keep');
});

test('export does not depend on unrelated local TOML and forwards only explicitly supplied auth',async t=>{
  const f=fixture(t,'invalid !!!');const output=path.join(f.home,'export.json');
  fs.writeFileSync(path.join(f.home,'auth.json'),JSON.stringify({tokens:{access_token:'do-not-implicitly-forward'}}));
  const result=await f.run('export','--output',output);
  assert.equal(result.ok,true);assert.deepEqual(JSON.parse(fs.readFileSync(output)),catalog);
  assert.equal(f.state.requests[0].headers.Authorization,undefined);
  assert(f.state.requests[0].url.includes('/v1/models?client_version='));
});

test('doctor initializes HTTP MCP and lists recovery tools without changing local files',async t=>{
  const f=fixture(t),requests=[];
  const server=http.createServer(async(q,s)=>{
    requests.push({url:q.url,headers:q.headers});
    if(q.headers['x-caveman-gateway-key']!==oldKey){s.writeHead(401);s.end();return;}
    if(q.url==='/prefix/v1/catalog'){s.writeHead(200,{'content-type':'application/json',etag:'"doctor"'});s.end(JSON.stringify(catalog));return;}
    if(q.method!=='POST'){s.writeHead(405);s.end();return;}
    const chunks=[];for await(const chunk of q)chunks.push(chunk);const message=JSON.parse(Buffer.concat(chunks));
    if(message.id===undefined){s.writeHead(202);s.end();return;}
    const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture-mcp',version:'1.0.0'}}:{tools:[{name:'caveman_retrieve',description:'Retrieve original fixture content',inputSchema:{type:'object',properties:{recovery_handle:{type:'string'}}}}]};
    s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port+'/prefix/v1',args=['--url',base,'--key-file',path.join(f.home,'key'),'--codex-home',f.home];
  await runClient(['configure',...args]);
  fs.writeFileSync(path.join(f.home,'auth.json'),JSON.stringify({tokens:{access_token:'header.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,email:'must-not-print@example.test'})).toString('base64url')+'.signature',refresh_token:'do-not-print-refresh'}}));
  const before=f.snapshot(),result=await runClient(['doctor',...args]);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.auth.status,'access_token_present');
  assert.deepEqual(result.mcp.tools,['caveman_retrieve']);assert(requests.some(r=>r.url==='/prefix/mcp'));
  assert.deepEqual(f.snapshot(),before);assert(!JSON.stringify(result).includes('must-not-print'));assert(!JSON.stringify(result).includes('do-not-print'));
  fs.writeFileSync(path.join(f.home,'auth.json'),JSON.stringify({tokens:{access_token:'header.'+Buffer.from(JSON.stringify({exp:1})).toString('base64url')+'.signature'}}));
  const expiredBefore=f.snapshot(),expired=await runClient(['doctor',...args]);
  assert.equal(expired.ok,false);assert.equal(expired.auth.status,'access_token_expired');
  assert(expired.warnings.includes('access_token_expired'));assert.deepEqual(f.snapshot(),expiredBefore);
  const cfgFile=path.join(f.home,'config.toml');
  fs.writeFileSync(cfgFile,patchConfig(fs.readFileSync(cfgFile,'utf8'),[
    {path:['model_providers','caveman_stack','env_http_headers'],value:{'X-CAVEMAN-GATEWAY-KEY':'STALE_KEY'}},
    {path:['mcp_servers','caveman','env_http_headers'],value:{'x-Caveman-gateway-KEY':'STALE_MCP_KEY'}}
  ]));
  const conflictBefore=f.snapshot(),conflict=await runClient(['doctor',...args]);
  assert.equal(conflict.ok,false);assert(conflict.warnings.includes('provider_gateway_env_header_conflict'));
  assert(conflict.warnings.includes('mcp_gateway_env_header_conflict'));
  assert.deepEqual(f.snapshot(),conflictBefore);assert(!JSON.stringify(conflict).includes('STALE_'));
});

test('openai doctor checks the actual bridge gateway authentication separately from direct catalog and MCP',async t=>{
  const f=fixture(t),requests=[];let requiredKey=oldKey;
  const server=http.createServer(async(q,s)=>{
    requests.push({url:q.url,headers:q.headers});
    if(q.headers['x-caveman-gateway-key']!==requiredKey){s.writeHead(401).end();return;}
    if(q.url==='/v1/catalog'){s.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(catalog));return;}
    if(q.url!=='/mcp'||q.method!=='POST'){s.writeHead(405).end();return;}
    const chunks=[];for await(const chunk of q)chunks.push(chunk);const message=JSON.parse(Buffer.concat(chunks));
    if(message.id===undefined){s.writeHead(202).end();return;}
    const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture-mcp',version:'1.0.0'}}:{tools:[{name:'caveman_retrieve',description:'Recovery',inputSchema:{type:'object'}}]};
    s.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port+'/v1';
  const bridge=createNativeBridge({upstreamUrl:base,key:oldKey});
  bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
  t.after(()=>{bridge.closeAllConnections();bridge.close();});
  const bridgeUrl='http://127.0.0.1:'+bridge.address().port+'/v1';
  const args=['--url',base,'--key-file',path.join(f.home,'key'),'--codex-home',f.home,'--provider','openai','--bridge-url',bridgeUrl];
  await runClient(['configure',...args]);
  fs.writeFileSync(path.join(f.home,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-user-auth-do-not-forward'}));
  const before=f.snapshot(),result=await runClient(['doctor',...args]);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.bridge.catalogAvailable,true);
  assert.equal(result.bridge.upstreamMatches,true);assert.equal(result.bridge.models,1);
  assert.equal(result.catalog.ok,true);assert.equal(result.mcp.ok,true);assert.deepEqual(f.snapshot(),before);
  assert(requests.every(r=>r.headers.authorization===undefined));
  requiredKey=newKey;fs.writeFileSync(path.join(f.home,'key'),newKey);
  const staleBefore=f.snapshot(),stale=await runClient(['doctor',...args]);
  assert.equal(stale.ok,false);assert.equal(stale.catalog.ok,true);assert.equal(stale.mcp.ok,true);
  assert.equal(stale.bridge.error,'BRIDGE_CATALOG_HTTP_401');assert.deepEqual(f.snapshot(),staleBefore);
  await assert.rejects(runClient(['configure',...args]),{code:'BRIDGE_CATALOG_HTTP_401'});
  assert.deepEqual(f.snapshot(),staleBefore);assert(!JSON.stringify(stale).includes(oldKey));assert(!JSON.stringify(stale).includes(newKey));
});

test('CLI validation output does not reveal gateway keys or raw invalid config',async t=>{
  const f=fixture(t,'invalid = "'+oldKey+'" unexpected');
  const child=spawn(process.execPath,['scripts/client.mjs','configure','--key-file',path.join(f.home,'key'),'--codex-home',f.home],{stdio:'pipe'});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  assert.equal((await once(child,'close'))[0],1);assert(!output.includes(oldKey));assert.equal(JSON.parse(output).error,'CONFIG_MERGE_REQUIRED');
});
