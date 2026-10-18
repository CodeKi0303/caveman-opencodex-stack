import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {accountMode} from '../scripts/account-mode.mjs';

async function fixture(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-account-mode-'));
  const config = {providers: {openai: {codexAccountMode: 'direct'},
    private: {baseUrl: 'http://fixture', apiKey: 'synthetic-private-value'}}, custom: true};
  const original = JSON.stringify(config);
  await fs.writeFile(path.join(configDir, 'config.json'), original);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push({method: req.method, url: req.url});
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-admin') {
      res.writeHead(401).end(JSON.stringify({error: 'synthetic-secret-must-not-be-printed'})); return;
    }
    if (req.method === 'GET' && req.url === '/api/providers') {
      res.end(JSON.stringify([{name: 'openai', ...config.providers.openai},
        {name: 'private', ...config.providers.private}])); return;
    }
    if (req.method === 'PATCH' && req.url === '/api/providers?name=openai') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body);
      assert.deepEqual(Object.keys(patch), ['codexAccountMode']);
      config.providers.openai.codexAccountMode = patch.codexAccountMode;
      await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(config));
      res.end(JSON.stringify({success: true})); return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await fs.rm(configDir, {recursive: true, force: true});
  });
  return {configDir, original, config, calls, baseUrl: `http://127.0.0.1:${server.address().port}`,
    adminKey: 'fixture-admin'};
}

test('mode changes use live PATCH, back up private config, verify persistence, and support rollback', async t => {
  const f = await fixture(t);
  const changed = await accountMode({...f, mode: 'pool'});
  assert.equal(changed.mode, 'pool');
  assert.equal(changed.previousMode, 'direct');
  assert.equal(changed.changed, true);
  assert.equal(await fs.readFile(path.join(changed.backup, 'config.json'), 'utf8'), f.original);
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(path.join(changed.backup, 'config.json'))).mode & 0o777, 0o600);
  const persisted = JSON.parse(await fs.readFile(path.join(f.configDir, 'config.json'), 'utf8'));
  assert.deepEqual(persisted.providers.private, f.config.providers.private);
  assert.equal(persisted.custom, true);
  assert.equal(persisted.providers.openai.codexAccountMode, 'pool');
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'PATCH', 'GET']);
  const restored = await accountMode({...f, mode: 'direct'});
  assert.equal(restored.mode, 'direct');
  assert.equal(restored.previousMode, 'pool');
  assert.ok(!JSON.stringify(changed).includes('synthetic-private-value'));
});

test('status and repeated selection do not mutate configuration or create backups', async t => {
  const f = await fixture(t);
  assert.deepEqual(await accountMode(f), {provider: 'openai', mode: 'direct', changed: false});
  assert.equal((await accountMode({...f, mode: 'direct'})).changed, false);
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'GET']);
  assert.deepEqual(await fs.readdir(f.configDir), ['config.json']);
});

test('invalid modes and authentication failures do not modify state or expose response bodies', async t => {
  const f = await fixture(t);
  await assert.rejects(accountMode({...f, mode: 'pull'}), /must be pool or direct/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(accountMode({...f, mode: 'pool', adminKey: 'wrong'}),
    {message: 'OpenCodex management API returned HTTP 401'});
  assert.deepEqual(await fs.readdir(f.configDir), ['config.json']);
  assert.equal(await fs.readFile(path.join(f.configDir, 'config.json'), 'utf8'), f.original);
});

test('management requests reject redirects and report a verification mismatch', async t => {
  const f = await fixture(t);
  const fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return new Response(JSON.stringify(options.method === 'PATCH' ? {success: true} :
      [{name: 'openai', codexAccountMode: 'direct'}]), {status: 200});
  };
  await assert.rejects(accountMode({...f, mode: 'pool', fetchImpl}), /verification failed/);
});
