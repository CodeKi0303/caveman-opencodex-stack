import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {installBridge, parseArgs, renderUnit, systemdQuote, readJson} from '../scripts/install-native-bridge-linux.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caveman-linux-installer-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const bridgeHome = path.join(root, 'codex', 'caveman-stack');
  const plan = {system: options.system ?? false, upstreamUrl: 'http://192.0.2.1:18787/v1', port: 18788,
    codexHome: path.dirname(bridgeHome), bridgeHome, nodePath: '/opt/node with space/bin/node',
    keyFile: path.join(root, 'gateway-key'), sourceBridgePath: path.join(root, 'native-bridge.mjs'), bridgePath: path.join(bridgeHome, 'native-bridge.mjs'),
    configPath: path.join(bridgeHome, 'native-bridge.json'), manifestPath: path.join(bridgeHome, 'native-bridge-install-linux.json'),
    unitPath: path.join(root, 'units', 'caveman-native-bridge.service'), unitName: 'caveman-native-bridge.service'};
  await fs.writeFile(plan.keyFile, 'fixture-key-'.repeat(4));
  await fs.writeFile(plan.sourceBridgePath, '// test only\n');
  const calls = [];
  let running = false, enabled = false, badCatalog = false, occupied = false;
  const dependencies = {platform: 'linux', uid: 0, sleep: async () => {},
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === plan.nodePath) return 'v22.13.0';
      assert.equal(command, 'systemctl');
      assert.equal(args.includes('--user'), !plan.system);
      const verb = args.filter(x => x !== '--user')[0];
      if (verb === 'show') {
        const exists = await fs.stat(plan.unitPath).then(() => true, () => false);
        return `LoadState=${exists ? 'loaded' : 'not-found'}\nFragmentPath=${exists ? plan.unitPath : ''}\nDropInPaths=\nUnitFileState=${enabled ? 'enabled' : exists ? 'disabled' : ''}\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${running ? 12345 : 0}`;
      }
      if (verb === 'enable') enabled = true;
      if (verb === 'disable') enabled = false;
      if (verb === 'start') running = true;
      if (verb === 'stop') running = false;
      return '';
    },
    portAvailable: async () => !running && !occupied,
    readJson: async url => url.endsWith('/healthz') ? {service: 'caveman-native-bridge', ok: true, upstreamUrl: plan.upstreamUrl, pid: running ? 12345 : 999} :
      badCatalog ? {models: []} : {models: [{slug: 'fixture-model'}]},
  };
  return {plan, dependencies, calls, get running() {return running;}, get enabled() {return enabled;},
    setBadCatalog: () => {badCatalog = true;}, setOccupied: () => {occupied = true;}};
}

test('Linux unit preserves quoted paths, disables dollar expansion and escapes systemd specifiers', () => {
  const unit = renderUnit({system: true, nodePath: '/opt/node binary', bridgePath: '/home/a $user/100%/"bridge".mjs', configPath: '/home/a/config\\file.json'});
  assert.ok(unit.includes('ExecStart=:"/opt/node binary" "/home/a $user/100%%/\\"bridge\\".mjs" --config "/home/a/config\\\\file.json"'));
  assert.match(unit, /WantedBy=multi-user.target/);
  assert.match(unit, /KillMode=control-group/);
  assert.doesNotMatch(unit, /timer|OnCalendar|OnUnitActiveSec/);
  assert.throws(() => systemdQuote('/tmp/file\nExecStart=/bin/false'), /control character/);
});

test('Linux options reject conflicting scopes and unsafe upstreams', () => {
  const args = ['--upstream-url', 'http://example.test:18787/v1/', '--key-file', '/tmp/key'];
  assert.equal(parseArgs(args).upstreamUrl, 'http://example.test:18787/v1');
  assert.equal(parseArgs([...args, '--port', '18789']).port, 18789);
  assert.throws(() => parseArgs([...args, '--system', '--user']), /exactly one/);
  assert.throws(() => parseArgs(['--upstream-url', 'http://user:secret@example.test/v1', '--key-file', '/tmp/key']), /without credentials/);
  assert.throws(() => parseArgs([...args, '--port', '0']), /Port/);
});

test('Linux install verifies catalog, installs only a bridge service and supports owned reinstall', async t => {
  const f = await fixture(t);
  const first = await installBridge(f.plan, f.dependencies);
  assert.equal(first.ok, true);
  assert.equal(first.models, 1);
  assert.equal(f.running, true);
  assert.equal(f.enabled, true);
  assert.match(await fs.readFile(f.plan.unitPath, 'utf8'), /WantedBy=default.target/);
  assert.deepEqual(await fs.readFile(f.plan.bridgePath), await fs.readFile(f.plan.sourceBridgePath));
  const config = await fs.readFile(f.plan.configPath, 'utf8');
  assert.equal(JSON.parse(config).keyFile, f.plan.keyFile);
  assert.ok(!config.includes('fixture-key-'));
  const second = await installBridge(f.plan, f.dependencies);
  assert.equal(second.ok, true);
  assert.ok(f.calls.some(call => call.includes('stop')));
  assert.equal(await fs.readFile(path.join(second.backup, 'native-bridge.json'), 'utf8'), config);
});

test('Linux installer refuses an occupied port or an altered unit before stopping anything', async t => {
  const occupied = await fixture(t);
  occupied.setOccupied();
  await assert.rejects(installBridge(occupied.plan, occupied.dependencies), /unowned process/);
  assert.equal(occupied.calls.some(call => call.includes('stop')), false);
  const altered = await fixture(t);
  await installBridge(altered.plan, altered.dependencies);
  await fs.appendFile(altered.plan.unitPath, '# external modification\n');
  altered.calls.length = 0;
  await assert.rejects(installBridge(altered.plan, altered.dependencies), /not owned/);
  assert.equal(altered.calls.some(call => call.includes('stop')), false);
});

test('Linux failed catalog check restores the previous config, unit and active service', async t => {
  const f = await fixture(t, {system: true});
  await installBridge(f.plan, f.dependencies);
  const files = [f.plan.unitPath, f.plan.configPath, f.plan.manifestPath, f.plan.bridgePath];
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  f.plan.upstreamUrl = 'http://192.0.2.2:18787/v1';
  f.setBadCatalog();
  await assert.rejects(installBridge(f.plan, f.dependencies), /catalog is invalid.*Previous installation restored/);
  for (const [index, file] of files.entries()) assert.deepEqual(await fs.readFile(file), before[index]);
  assert.equal(f.running, true);
  assert.equal(f.enabled, true);
});

test('Linux first-install failure removes its files and disables its unit', async t => {
  const f = await fixture(t);
  f.setBadCatalog();
  await assert.rejects(installBridge(f.plan, f.dependencies), /Previous installation restored/);
  assert.equal(f.running, false);
  assert.equal(f.enabled, false);
  for (const file of [f.plan.unitPath, f.plan.configPath, f.plan.manifestPath, f.plan.bridgePath]) await assert.rejects(fs.stat(file), {code: 'ENOENT'});
});

test('Linux readiness HTTP rejects redirects and malformed JSON without following destinations', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {requests++; if (req.url === '/redirect') res.writeHead(302, {location: '/ok'}).end(); else res.end('broken json');});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(readJson(url + '/redirect'), /HTTP 302/);
  assert.equal(requests, 1);
  await assert.rejects(readJson(url + '/invalid'), /not JSON/);
});
