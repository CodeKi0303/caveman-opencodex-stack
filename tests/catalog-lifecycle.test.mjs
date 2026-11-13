import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway} from '../src/gateway.mjs';
import {createCatalogRefresher} from '../src/catalog-refresh.mjs';
import {runClient} from '../scripts/client-lib.mjs';

test('real HTTP catalog lifecycle repairs an empty cache after 304 and discovers server changes during sync',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-lifecycle-')),home=path.join(dir,'client');
  fs.mkdirSync(home);const keyFile=path.join(dir,'key'),key='synthetic-lifecycle-key-'.repeat(3);
  fs.writeFileSync(keyFile,key);
  let offline=false,requests=0;
  const catalog={models:[{slug:'fixture',display_name:'Fixture',visibility:'list',context_window:272000,custom_metadata:{keep:true}}]};
  const upstream=http.createServer((_req,res)=>{
    requests++;res.writeHead(offline?503:200,{'content-type':'application/json'});
    res.end(offline?'{}':JSON.stringify(catalog));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const catalogPath=path.join(dir,'server.json');
  const gateway=createGateway({key,catalogPath,refreshCatalog:createCatalogRefresher({
    url:`http://127.0.0.1:${upstream.address().port}/models`,output:catalogPath})});
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  t.after(()=>{
    gateway.closeAllConnections();gateway.close();upstream.closeAllConnections();upstream.close();
    assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});
  });
  const options=['--url',`http://127.0.0.1:${gateway.address().port}/v1`,'--key-file',keyFile,'--codex-home',home];
  await runClient(['configure',...options]);
  const local=path.join(home,'opencodex-catalog.json'),cache=path.join(home,'models_cache.json');
  const configBefore=fs.readFileSync(path.join(home,'config.toml'),'utf8');
  const localBefore=fs.readFileSync(local,'utf8'),mtime=fs.statSync(local).mtimeMs;
  fs.writeFileSync(cache,'');
  const repaired=await runClient(['sync',...options]);
  assert.equal(repaired.notModified,true);assert.equal(repaired.catalogChanged,false);
  assert.equal(repaired.cacheRepaired,true);assert.equal(repaired.restartCodex,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache)).models,catalog.models);
  assert.equal(fs.readFileSync(local,'utf8'),localBefore);assert.equal(fs.statSync(local).mtimeMs,mtime);
  const noop=await runClient(['sync',...options]);assert.equal(noop.changed,false);assert.equal(noop.backup,null);
  catalog.models[0].context_window=872000;catalog.models[0].visibility='hide';
  const changed=await runClient(['sync',...options]);assert.equal(changed.catalogChanged,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(local)).models,catalog.models);
  assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'),configBefore);
  const lastGood=fs.readFileSync(local,'utf8');fs.writeFileSync(cache,'');offline=true;
  await assert.rejects(runClient(['sync',...options]),error=>error.code==='CATALOG_HTTP_503');
  assert.equal(fs.readFileSync(local,'utf8'),lastGood);assert.equal(fs.readFileSync(cache,'utf8'),'');
  offline=false;assert.equal((await runClient(['sync',...options])).cacheRepaired,true);
  assert.equal(requests,6);
});
