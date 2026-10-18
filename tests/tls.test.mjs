import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createGateway} from '../src/gateway.mjs';
test('private CA: untrusted client fails, explicit CA succeeds',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stack-tls-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
  const cert=path.join(dir,'ca.crt'),priv=path.join(dir,'key.pem'),catalog=path.join(dir,'catalog.json');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',priv,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.writeFileSync(catalog,'{"models":[{"slug":"fixture","display_name":"Fixture"}]}');
  const key='b'.repeat(64);fs.writeFileSync(path.join(dir,'gateway-key'),key);
  const s=createGateway({key,catalogPath:catalog,tls:{key:fs.readFileSync(priv),cert:fs.readFileSync(cert)}});
  s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});
  async function client(trust){
    const env={...process.env};delete env.NODE_EXTRA_CA_CERTS;if(trust)env.NODE_EXTRA_CA_CERTS=cert;
    const p=spawn(process.execPath,['scripts/client.mjs','sync','--url','https://127.0.0.1:'+s.address().port+'/v1','--key-file',path.join(dir,'gateway-key'),'--codex-home',path.join(dir,'codex')],{env,stdio:'ignore'});
    return (await once(p,'exit'))[0];
  }
  assert.notEqual(await client(false),0);assert.equal(await client(true),0);
});
