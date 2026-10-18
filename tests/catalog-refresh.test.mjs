import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {refreshCatalog,refreshCatalogAtStartup} from '../src/catalog-refresh.mjs';

test('catalog refresh retains full metadata and leaves unchanged files untouched', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-refresh-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const output = path.join(dir, 'models.json');
  const catalog = {models: [{slug: 'test', display_name: 'Test', base_instructions: 'upstream fixture'}]};
  const options = {url: 'http://127.0.0.1/models', output,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return Response.json(catalog);
    }};
  assert.deepEqual(await refreshCatalog(options), {changed: true, models: 1});
  const modified = (await fs.stat(output)).mtimeMs;
  assert.deepEqual(await refreshCatalog(options), {changed: false, models: 1});
  assert.equal((await fs.stat(output)).mtimeMs, modified);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), catalog);
  assert.deepEqual(await fs.readdir(dir), ['models.json']);
});

test('startup refresh retries only until success and finishes after bounded failures', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-startup-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const output=path.join(dir,'models.json');
  let requests=0,waits=0;
  const result=await refreshCatalogAtStartup({url:'http://localhost/models',output,
    fetchImpl:async()=>++requests===1?new Response('',{status:503}):Response.json({models:[{slug:'ready',display_name:'Ready'}]})},
    {wait:async()=>{waits++;}});
  assert.equal(result.ok,true);assert.equal(requests,2);assert.equal(waits,1);
  const before=await fs.readFile(output,'utf8');requests=0;waits=0;
  const failed=await refreshCatalogAtStartup({url:'http://localhost/models',output,
    fetchImpl:async()=>{requests++;throw Error('offline');}}, {wait:async()=>{waits++;}});
  assert.deepEqual(failed,{ok:false,last_good_preserved:true});assert.equal(requests,3);assert.equal(waits,2);
  assert.equal(await fs.readFile(output,'utf8'),before);
});

test('failed and malformed catalog refreshes preserve the last good file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-failure-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const output = path.join(dir, 'models.json');
  const original = '{"models":[{"slug":"old","display_name":"Old"}]}\n';
  await fs.writeFile(output, original);
  for (const fetchImpl of [
    async () => new Response('unavailable', {status: 503}),
    async () => new Response('invalid json'),
    async () => Response.json({models: []}),
    async () => Response.json({models: [{slug: 'bad'}]}),
    async () => Response.json({models: [{slug: 'same', display_name: 'One'}, {slug: 'same', display_name: 'Two'}]}),
    async () => { throw Error('connection unavailable'); }
  ]) {
    await assert.rejects(refreshCatalog({url: 'http://127.0.0.1/models', output, fetchImpl}));
    assert.equal(await fs.readFile(output, 'utf8'), original);
  }
});
