import fs from 'node:fs';
import {companyCaEnvironment} from './company-ca.mjs';
import {superviseComponents} from './process-supervisor.mjs';
process.umask(0o077);
for(const p of ['/state/opencodex','/state/codex','/state/caveman','/state/catalog']) fs.mkdirSync(p,{recursive:true,mode:0o700});
const config='/state/codex/config.toml';
if(!fs.existsSync(config)) fs.writeFileSync(config,'model = "gpt-6-astra"\n');
const env={...process.env,CAVE_MAX_REQUEST_BYTES:process.env.MAX_REQUEST_BYTES||'268435456'};
// Preserve company bypasses and always bypass proxies for internal traffic.
env.NO_PROXY=[env.NO_PROXY||env.no_proxy||'','localhost','127.0.0.1','::1'].filter(Boolean).join(',');
env.no_proxy=env.NO_PROXY;
Object.assign(env,companyCaEnvironment());
const supervisor=superviseComponents([
  {name:'opencodex',command:'/app/node_modules/.bin/bun',args:['/app/src/opencodex.ts']},
  {name:'caveman',command:'/opt/caveman/bin/caveman-proxy'},
  {name:'gateway',command:process.execPath,args:['/app/src/gateway.mjs']},
  {name:'catalog',command:process.execPath,args:['/app/src/catalog-refresh.mjs'],required:false}
],{env});
process.on('SIGTERM',()=>supervisor.stop(0,'SIGTERM'));
process.on('SIGINT',()=>supervisor.stop(0,'SIGINT'));
