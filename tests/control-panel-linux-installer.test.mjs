import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {installControlPanel, parseArgs, renderUnit, readPage, ownsListeningPort} from '../scripts/install-control-panel-linux.mjs';

async function fixture(t, {system = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caveman-control-linux-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const bridgeHome = path.join(root, 'codex', 'caveman-stack');
  const plan = {system, codexHome: path.dirname(bridgeHome), bridgeHome, nodePath: '/opt/node with space/bin/node',
    entryPath: path.join(root, 'control-panel.mjs'), configPath: path.join(bridgeHome, 'native-bridge.json'),
    manifestPath: path.join(bridgeHome, 'control-panel-install-linux.json'),
    unitPath: path.join(root, 'units', 'caveman-control-panel.service'), unitName: 'caveman-control-panel.service'};
  await fs.mkdir(bridgeHome, {recursive: true});
  await fs.writeFile(plan.entryPath, '// test only\n');
  const config = '{"port":18789,"controlPort":18786,"compression":false,"keyFile":"/private/key","custom":"preserve me"}\n';
  await fs.writeFile(plan.configPath, config);
  const calls = [];
  let running = false, enabled = false, occupied = false, badPage = false, wrongPid = false, override = false, loadState;
  const dependencies = {platform: 'linux', uid: 0, sleep: async () => {}, readinessAttempts: 1,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === plan.nodePath) return 'v22.13.0';
      assert.equal(command, 'systemctl');
      assert.equal(args.includes('--user'), !plan.system);
      const verb = args.filter(x => x !== '--user')[0];
      if (verb === 'show') {
        const exists = await fs.stat(plan.unitPath).then(() => true, () => false);
        return `LoadState=${loadState || (exists ? 'loaded' : 'not-found')}\nFragmentPath=${exists ? plan.unitPath : ''}\nDropInPaths=${override ? '/override.conf' : ''}\nUnitFileState=${enabled ? 'enabled' : exists ? 'disabled' : ''}\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${running ? 12345 : 0}`;
      }
      if (verb === 'enable') enabled = true;
      if (verb === 'disable') enabled = false;
      if (verb === 'start') running = true;
      if (verb === 'stop') running = false;
      return '';
    },
    portAvailable: async () => !running && !occupied,
    ownsListeningPort: async pid => running && pid === 12345 && !wrongPid,
    readPage: async () => badPage ? '<html>another service</html>' : '<meta name="control-token" content="' + 'a'.repeat(64) + '"><title>Caveman · 로컬 제어실</title>',
  };
  return {plan, config, dependencies, calls, get running() {return running;}, get enabled() {return enabled;},
    setBadPage: () => {badPage = true;}, setOccupied: () => {occupied = true;}, setWrongPid: () => {wrongPid = true;},
    setOverride: () => {override = true;}, setLoadState: value => {loadState = value;},
    setInactive: () => {running = false; enabled = false;}};
}

test('control panel unit escapes systemd paths and uses explicit user/system scopes', () => {
  const unit = renderUnit({system: false, nodePath: '/opt/node binary', entryPath: '/home/a $user/100%/"control".mjs', configPath: '/home/a/config\\file.json'});
  assert.ok(unit.includes('ExecStart=:"/opt/node binary" "/home/a $user/100%%/\\"control\\".mjs" --config "/home/a/config\\\\file.json"'));
  assert.match(unit, /WantedBy=default.target/);
  assert.match(renderUnit({system: true, nodePath: '/node', entryPath: '/control.mjs', configPath: '/config.json'}), /WantedBy=multi-user.target/);
  assert.doesNotMatch(unit, /timer|OnCalendar|OnUnitActiveSec/);
  assert.equal(parseArgs([]).system, false);
  assert.equal(parseArgs(['--system']).system, true);
  assert.throws(() => parseArgs(['--system', '--user']), /exactly one/);
  assert.throws(() => parseArgs(['--codex-home']), /Missing/);
  assert.throws(() => parseArgs(['--node-path', '/node', '--node-path', '/other']), /repeated/);
});

test('Linux panel install and owned restart preserve native bridge settings byte for byte', async t => {
  const f = await fixture(t);
  const first = await installControlPanel(f.plan, f.dependencies);
  assert.equal(first.ok, true);
  assert.equal(first.url, 'http://127.0.0.1:18786/');
  assert.equal(f.running, true);
  assert.equal(f.enabled, true);
  assert.equal(await fs.readFile(f.plan.configPath, 'utf8'), f.config);
  const unit = await fs.readFile(f.plan.unitPath, 'utf8');
  const second = await installControlPanel(f.plan, f.dependencies);
  assert.equal(second.ok, true);
  assert.equal(await fs.readFile(path.join(second.backup, 'caveman-control-panel.service'), 'utf8'), unit);
  assert.equal(await fs.readFile(f.plan.configPath, 'utf8'), f.config);
  assert.ok(f.calls.some(call => call.includes('stop')));
});

test('Linux panel refuses foreign, overridden and altered units or a foreign port before stopping', async t => {
  for (const condition of ['occupied', 'altered', 'override', 'wrongPid', 'foreign']) {
    const f = await fixture(t);
    if (condition !== 'occupied' && condition !== 'foreign') await installControlPanel(f.plan, f.dependencies);
    if (condition === 'occupied') f.setOccupied();
    if (condition === 'altered') await fs.appendFile(f.plan.unitPath, '# modified\n');
    if (condition === 'override') f.setOverride();
    if (condition === 'wrongPid') f.setWrongPid();
    if (condition === 'foreign') f.setLoadState('loaded');
    f.calls.length = 0;
    await assert.rejects(installControlPanel(f.plan, f.dependencies), /unowned process|not owned|external overrides|different control panel/);
    assert.equal(f.calls.some(call => call.includes('stop')), false, condition);
    assert.equal(await fs.readFile(f.plan.configPath, 'utf8'), f.config);
  }
});

test('Linux panel failed readiness restores previous unit, enabled state and running service', async t => {
  const f = await fixture(t, {system: true});
  await installControlPanel(f.plan, f.dependencies);
  const files = [f.plan.unitPath, f.plan.manifestPath, f.plan.configPath];
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  f.setBadPage();
  await assert.rejects(installControlPanel(f.plan, f.dependencies), /did not become ready.*Previous installation restored/);
  for (const [index, file] of files.entries()) assert.deepEqual(await fs.readFile(file), before[index]);
  assert.equal(f.running, true);
  assert.equal(f.enabled, true);
});

test('Linux panel failure leaves previously inactive/disabled services inactive/disabled', async t => {
  const f = await fixture(t);
  await installControlPanel(f.plan, f.dependencies);
  f.setInactive();
  f.setBadPage();
  await assert.rejects(installControlPanel(f.plan, f.dependencies), /Previous installation restored/);
  assert.equal(f.running, false);
  assert.equal(f.enabled, false);
});

test('Linux panel first-install failure removes only owned files and preserves configuration', async t => {
  const f = await fixture(t);
  f.setBadPage();
  await assert.rejects(installControlPanel(f.plan, f.dependencies), /Previous installation restored/);
  assert.equal(f.running, false);
  assert.equal(f.enabled, false);
  for (const file of [f.plan.unitPath, f.plan.manifestPath]) await assert.rejects(fs.stat(file), {code: 'ENOENT'});
  assert.equal(await fs.readFile(f.plan.configPath, 'utf8'), f.config);
});

test('Linux panel rejects non-root system install and conflicting ports without modifying services', async t => {
  const f = await fixture(t, {system: true});
  await assert.rejects(installControlPanel(f.plan, {...f.dependencies, uid: 1000}), /root/);
  await fs.writeFile(f.plan.configPath, '{"port":18786}');
  await assert.rejects(installControlPanel(f.plan, f.dependencies), /Invalid control or bridge port/);
  assert.equal(f.calls.length, 0);
});

test('Linux panel installer rejects an existing installer lock without touching services', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.plan.bridgeHome, 'control-panel-install-linux.lock'));
  await assert.rejects(installControlPanel(f.plan, f.dependencies), /already in progress/);
  assert.equal(f.calls.some(call => call[0] === 'systemctl'), false);
});

test('panel readiness rejects redirects instead of fetching another destination', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {requests++; res.writeHead(302, {location: '/ok'}).end();});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  await assert.rejects(readPage(`http://127.0.0.1:${server.address().port}/`), /HTTP 302/);
  assert.equal(requests, 1);
});

test('kernel port ownership check identifies this process only on loopback', {skip: process.platform !== 'linux'}, async t => {
  const server = http.createServer((req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  assert.equal(await ownsListeningPort(process.pid, server.address().port), true);
  assert.equal(await ownsListeningPort(0, server.address().port), false);
  assert.equal(await ownsListeningPort(2147483647, server.address().port), false);
});
