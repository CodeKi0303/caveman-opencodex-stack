import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

test('real Caveman preserves account and Codex routing headers',
  {skip: !process.env.CAVEMAN_PROXY_BIN, timeout: 30000}, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caveman-headers-'));
    let child;
    const upstream = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* Consume the synthetic request. */ }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({headers: req.headers, url: req.url}));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      if (child && child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(force);
      }
      await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
      await fs.rm(dir, {recursive: true, force: true});
    });
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const template = await fs.readFile(new URL('../config/chain.yaml', import.meta.url), 'utf8');
    const config = template.replace('mode: compress', 'mode: record')
      .replace('listen: 127.0.0.1:8787', 'listen: 127.0.0.1:' + port)
      .replace('http://127.0.0.1:10101/v1', 'http://127.0.0.1:' + upstream.address().port + '/v1');
    const configPath = path.join(dir, 'chain.yaml');
    await fs.writeFile(configPath, config);
    child = spawn(process.env.CAVEMAN_PROXY_BIN, [], {stdio: 'ignore', env: {
      ...process.env, CAVEMAN_HOME: dir, CAVEMAN_CONFIG: configPath,
      CAVEMAN_CCR_DB: path.join(dir, 'ccr.db'), CAVEMAN_MODE: 'record',
      CAVEMAN_LISTEN: '127.0.0.1:' + port, CAVE_SSRF_ALLOWLIST: '127.0.0.1',
      CAVEMAN_OFFLINE: '1', CAVEMAN_TELEMETRY: '0'
    }});
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw Error('Caveman exited before becoming ready');
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/health/live', {signal: AbortSignal.timeout(500)});
        await r.arrayBuffer(); ready = r.ok;
      } catch { /* The new listener may not be ready yet. */ }
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'Caveman listener must become ready');
    const headers = {'content-type': 'application/json', authorization: 'Bearer synthetic-fixture',
      'chatgpt-account-id': 'fixture-account', 'x-openai-subagent': 'thread_spawn',
      'x-codex-turn-metadata': '{"turn_source":"thread_spawn"}',
      'session-id': 'fixture-session', 'thread-id': 'fixture-thread',
      'x-codex-parent-thread-id': 'fixture-parent'};
    const response = await fetch('http://127.0.0.1:' + port + '/compat/opencodex/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({model: 'fixture', input: 'Synthetic header test.', stream: false}),
      signal: AbortSignal.timeout(10000)
    });
    assert.equal(response.status, 200);
    const received = await response.json();
    for (const [name, value] of Object.entries(headers)) assert.equal(received.headers[name], value, name);
    assert.equal(received.url, '/v1/responses');
  });
