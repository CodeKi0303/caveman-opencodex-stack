import fs from 'node:fs';
import {spawn} from 'node:child_process';
process.umask(0o077);
for(const p of ['/state/opencodex','/state/codex','/state/caveman','/state/catalog']) fs.mkdirSync(p,{recursive:true,mode:0o700});
const config='/state/codex/config.toml';
if(!fs.existsSync(config)) fs.writeFileSync(config,'model = "gpt-6-astra"\n');
const certs=fs.existsSync('/certs') ? fs.readdirSync('/certs').filter(f=>/\.(crt|pem)$/.test(f)&&f!=='server.crt') : [];
const env={...process.env,CAVE_MAX_REQUEST_BYTES:process.env.MAX_REQUEST_BYTES||'268435456'};
// Preserve company bypasses and always bypass proxies for internal traffic.
env.NO_PROXY=[env.NO_PROXY||env.no_proxy||'','localhost','127.0.0.1','::1'].filter(Boolean).join(',');
env.no_proxy=env.NO_PROXY;
if(certs.length) {
  const bundle='/state/company-ca-bundle.pem';
  fs.writeFileSync(bundle,[fs.readFileSync('/etc/ssl/certs/ca-certificates.crt','utf8'),...certs.map(f=>fs.readFileSync('/certs/'+f,'utf8'))].join('\n'));
  Object.assign(env,{NODE_EXTRA_CA_CERTS:bundle,SSL_CERT_FILE:bundle,CURL_CA_BUNDLE:bundle,REQUESTS_CA_BUNDLE:bundle});
}
const children=[];
let stopping=false;
function stop(code=0) {
  if(stopping)return;
  stopping=true;
  for(const p of children)p.kill('SIGTERM');
  const timer=setTimeout(()=>{for(const p of children)p.kill('SIGKILL');process.exit(code);},12000);
  timer.unref();
  Promise.all(children.map(p=>p.exitCode!==null?Promise.resolve():new Promise(r=>p.once('exit',r)))).then(()=>process.exit(code));
}
for(const [bin,args,required=true] of [
  ['/app/node_modules/.bin/bun',['/app/src/opencodex.ts']],
  ['/opt/caveman/bin/caveman-proxy',[]],
  [process.execPath,['/app/src/gateway.mjs']],
  [process.execPath,['/app/src/catalog-refresh.mjs'],false]
]) {
  const p=spawn(bin,args,{env,stdio:['ignore','inherit','inherit']});children.push(p);
  p.once('error',()=>{console.error(required?'Component failed to start':'Startup catalog refresh unavailable');if(required)stop(1);});
  p.once('exit',()=>{if(required&&!stopping){console.error('Component exited; stopping stack');stop(1);}});
}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
