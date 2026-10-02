// Node >=22.13; works on Windows, Linux, and WSL. No SSH tunnel required.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [command,...args]=process.argv.slice(2);
const opts={};
for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!args[i+1])throw Error('Expected --name value');opts[args[i].slice(2)]=args[++i];}
const base=new URL(opts.url||'http://127.0.0.1:18787/v1');
if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid URL');
if(!['export','sync','configure'].includes(command)||!opts['key-file'])throw Error('Usage: client.mjs export|sync|configure --url http(s)://host:port/v1 --key-file FILE [--codex-home DIR] [--output FILE] [--auth-file FILE]');
const key=fs.readFileSync(opts['key-file'],'utf8').trim();
if(key.length<32)throw Error('Invalid gateway key');
const headers={'x-caveman-gateway-key':key};
if(opts['auth-file']){
  const a=JSON.parse(fs.readFileSync(opts['auth-file'],'utf8'));
  if(a.tokens?.access_token){headers.Authorization='Bearer '+a.tokens.access_token;headers['chatgpt-account-id']=a.tokens.account_id||'';}
  else if(a.OPENAI_API_KEY)headers.Authorization='Bearer '+a.OPENAI_API_KEY;
}
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).dependencies['@openai/codex'];
const endpoint=base.toString().replace(/\/$/,'')+(command==='export'?'/models?client_version='+encodeURIComponent(version):'/catalog');
// Refuse redirects so account credentials cannot follow another destination.
const response=await fetch(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Catalog HTTP '+response.status);
const catalog=await response.json();
if(!Array.isArray(catalog.models)||!catalog.models.length||!catalog.models.every(m=>typeof m.slug==='string'&&typeof m.display_name==='string'))throw Error('Invalid or empty model catalog');
function atomic(file,data){const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,data,{mode:0o600});fs.renameSync(temp,file);}
if(command==='export'){
  const target=opts.output||'/state/catalog/models.json';fs.mkdirSync(path.dirname(target),{recursive:true});atomic(target,JSON.stringify(catalog,null,2)+'\n');
  console.log(JSON.stringify({catalog:target,models:catalog.models.filter(m=>m.visibility==='list').map(m=>m.slug)}));
}else{
  const home=path.resolve(opts['codex-home']||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));fs.mkdirSync(home,{recursive:true,mode:0o700});
  const cfg=path.join(home,'config.toml'),target=path.join(home,'opencodex-catalog.json');
  const original=fs.existsSync(cfg)?fs.readFileSync(cfg,'utf8').replace(/^\uFEFF/,''):'';
  if(original.includes('"""')||original.includes("'''"))throw Error('Multiline TOML needs manual merge; no changes made');
  const boundary=original.search(/^\s*\[/m);
  let top=boundary<0?original:original.slice(0,boundary), rest=boundary<0?'':original.slice(boundary);
  top=top.replace(/^[ \t]*(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')[ \t]*=.*(?:\r?\n|$)/gm,'');
  top='model_catalog_json = '+JSON.stringify(target.replaceAll('\\','/'))+'\n'+top;
  if(command==='configure'){
    if(/^\s*(?:profile|"model_provider"|'model_provider')\s*=/m.test(top))throw Error('Active profile or quoted provider needs manual merge');
    if(/\[\s*model_providers\.(?:caveman_stack|"caveman_stack"|'caveman_stack')/.test(rest))throw Error('Provider already exists: use sync; edit connection settings manually');
    top=top.replace(/^\s*model_provider\s*=.*(?:\r?\n|$)/gm,'');
    top='model_provider = "caveman_stack"\n'+top;
    rest+='\n[model_providers.caveman_stack]\nname = "Caveman + OpenCodex"\nbase_url = '+JSON.stringify(base.toString().replace(/\/$/,''))+'\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n[model_providers.caveman_stack.http_headers]\nx-caveman-gateway-key = '+JSON.stringify(key)+'\n';
  }
  const backup=path.join(home,'before-caveman-'+Date.now());fs.mkdirSync(backup,{mode:0o700});
  const cache=path.join(home,'models_cache.json'),files=[cfg,target,cache],existed=files.map(f=>fs.existsSync(f));
  files.forEach((f,i)=>{if(existed[i])fs.copyFileSync(f,path.join(backup,path.basename(f)));});
  fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({files,existed}),{mode:0o600});
  try{atomic(target,JSON.stringify(catalog,null,2)+'\n');atomic(cache,JSON.stringify({fetched_at:'2000-01-01T00:00:00Z',client_version:'0.0.0',models:catalog.models}));atomic(cfg,top+rest);}
  catch(e){files.forEach((f,i)=>{if(existed[i])fs.copyFileSync(path.join(backup,path.basename(f)),f);else if(fs.existsSync(f))fs.unlinkSync(f);});throw e;}
  console.log(JSON.stringify({catalog:target,backup,restartCodex:true}));
}
