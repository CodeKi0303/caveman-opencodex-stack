import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { layout, makeConfig, parseArgs, syncArguments, systemdUnits, systemdArgument, windowsCommand, windowsWrapper, manage, runSync } from '../scripts/schedule.mjs';

test('scheduler identity is stable per Codex home and Windows case-insensitive', () => {
  assert.equal(layout({ 'codex-home': 'C:\\Users\\Me\\Codex Home' }, 'win32').name, layout({ 'codex-home': 'c:\\users\\me\\codex home' }, 'win32').name);
  assert.notEqual(layout({ 'codex-home': '/home/a/.codex' }, 'linux').name, layout({ 'codex-home': '/home/a/.codex-other' }, 'linux').name);
  assert.throws(() => parseArgs(['install', '--key', 'secret']), /schedule.mjs/);
  assert.throws(() => parseArgs(['remove', '--url', 'http://localhost']), /schedule.mjs/);
});

test('Windows action is hidden, interactive current-user only, and safely handles spaces and quotes', () => {
  const target = layout({ 'codex-home': "C:\\Users\\한국 사용자 O'Brian\\Codex Home" }, 'win32');
  const config = makeConfig({ url: 'http://192.168.50.61:18787/v1', 'key-file': "C:\\Keys\\O'Brian key" }, target, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Stack Folder\\scripts\\schedule.mjs');
  const generated = windowsCommand('install', target, config);
  assert.match(generated, /-WindowStyle Hidden/);
  assert.match(generated, /-LogonType Interactive -RunLevel Limited/);
  assert.match(generated, /-AtLogOn -User \$identity/);
  assert.match(generated, /-Minutes 15/);
  assert.match(generated, /O''Brian/);
  assert.match(generated, /-Force/);
  assert.match(generated, /Refusing to modify a task not owned/);
  assert.doesNotMatch(generated, /-Password|RunLevel Highest|SYSTEM|gateway-key/);
  assert.match(windowsWrapper, /Get-Content -LiteralPath/);
  assert.match(windowsWrapper, /-Raw -Encoding UTF8 \| ConvertFrom-Json/);
  assert.deepEqual(syncArguments(config), [config.client, 'sync', '--url', config.url, '--key-file', config.keyFile, '--codex-home', target.home]);
});

test('systemd uses a persistent calendar and startup trigger with literal path escaping', () => {
  const target = layout({ 'codex-home': '/home/me/Codex $% "Home' }, 'linux', { XDG_CONFIG_HOME: '/tmp/config' });
  const config = makeConfig({ url: 'https://example.test:18787/v1', 'key-file': '/keys/my key' }, target, '/tools/node', '/repo with spaces/scripts/schedule.mjs');
  const units = systemdUnits(target, config);
  assert.match(units.timer, /Persistent=true/);
  assert.match(units.timer, /OnStartupSec=30s/);
  assert.match(units.timer, /OnCalendar=\*-\*-\* \*:00\/15:00/);
  assert.match(systemdUnits(target, { ...config, intervalMinutes: 60 }).timer, /OnCalendar=\*-\*-\* \*:00:00/);
  assert.match(units.service, /"\/repo with spaces\/scripts\/schedule.mjs"/);
  assert.match(units.service, /\$\$%%/);
  assert.equal(systemdArgument('/a/"b"\\c'), '"/a/\\"b\\"\\\\c"');
  assert.throws(() => systemdArgument('/tmp/evil\nExecStart=bad'), /control/);
  assert.throws(() => makeConfig({ url: 'http://user:secret@host/v1', 'key-file': '/key' }, target), /credentials/);
  assert.throws(() => makeConfig({ url: 'http://host/v1', 'key-file': '/key', 'interval-minutes': '7' }, target), /divisor/);
});

test('install/update/status/remove are opt-in and operate only on owned user units (mock scheduler)', t => {
  // Real systemctl / Scheduled Tasks are never invoked by this test.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-schedule-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'codex home'), repo = path.join(temp, 'repo with spaces'), key = path.join(temp, 'gateway-key');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'schedule.mjs'), ''); fs.writeFileSync(path.join(repo, 'client.mjs'), ''); fs.writeFileSync(key, 'secret-never-in-command-lines');
  // The filesystem operation test uses the host path flavor; Linux unit rendering is independently tested above.
  if (process.platform !== 'linux') { t.skip('Linux filesystem lifecycle; scheduler calls are mocked'); return; }
  const calls = [], env = { XDG_CONFIG_HOME: path.join(temp, 'config') };
  const deps = { platform: 'linux', env, exec: (command, args) => { calls.push([command, args]); return ''; }, script: path.join(repo, 'schedule.mjs') };
  const options = { 'codex-home': home, url: 'http://localhost:18787/v1', 'key-file': key };
  assert.equal(manage('status', { 'codex-home': home }, deps).installed, false);
  assert.equal(calls.length, 0);
  const first = manage('install', options, deps), second = manage('install', { ...options, 'interval-minutes': '30' }, deps);
  assert.equal(first.name, second.name);
  assert.equal(manage('status', { 'codex-home': home }, deps).installed, true);
  assert.ok(calls.every(([command, args]) => command === 'systemctl' && args[0] === '--user'));
  assert.doesNotMatch(JSON.stringify(calls), /secret-never/);
  const target = layout(options, 'linux', env);
  fs.writeFileSync(path.join(target.stateDir, 'user-note'), 'keep me');
  manage('remove', { 'codex-home': home }, deps);
  assert.equal(fs.readFileSync(path.join(target.stateDir, 'user-note'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(target.unitsDir, target.name + '.timer')), false);
});

test('Windows install/update/status/remove never invokes a real scheduler in tests', { skip: process.platform !== 'win32' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-schedule-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, "O'Brian Codex"), key = path.join(temp, 'gateway-key');
  fs.writeFileSync(key, 'secret-never-in-command-lines');
  const calls = [];
  let registered = false;
  const exec = (command, args) => {
    const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    calls.push(source);
    if (source.includes('Unregister-ScheduledTask')) registered = false;
    else if (source.includes('Register-ScheduledTask -TaskName')) registered = true;
    return JSON.stringify({ installed: registered });
  };
  const options = { 'codex-home': home, url: 'http://localhost:18787/v1', 'key-file': key };
  const first = manage('install', options, { exec });
  const second = manage('install', { ...options, 'interval-minutes': '30' }, { exec });
  assert.equal(first.name, second.name);
  assert.equal(manage('status', { 'codex-home': home }, { exec }).installed, true);
  const target = layout(options);
  assert.equal(JSON.parse(fs.readFileSync(target.config)).intervalMinutes, 30);
  assert.doesNotMatch(calls.join('\n'), /secret-never-in-command-lines/);
  manage('remove', { 'codex-home': home }, { exec });
  assert.equal(fs.existsSync(target.stateDir), false);
  assert.equal(manage('status', { 'codex-home': home }, { exec }).installed, false);
});

test('scheduled worker passes only paths, records exit status, and replaces its last result', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-schedule-run-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = layout({ 'codex-home': path.join(temp, 'Codex Home') });
  const fakeClient = path.join(temp, 'fake client.mjs');
  fs.writeFileSync(fakeClient, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;');
  fs.mkdirSync(target.stateDir, { recursive: true });
  const config = makeConfig({ url: 'http://localhost:18787/v1', 'key-file': path.join(temp, 'key file') }, target);
  config.client = fakeClient;
  fs.writeFileSync(target.config, JSON.stringify(config));
  fs.writeFileSync(target.log, 'previous log content');
  assert.equal(runSync(target.config), 7);
  const result = JSON.parse(fs.readFileSync(target.log, 'utf8'));
  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.output), syncArguments(config).slice(1));
  assert.doesNotMatch(fs.readFileSync(target.log, 'utf8'), /previous log content/);
  fs.writeFileSync(target.config, JSON.stringify({ ...config, owner: 'someone else' }));
  assert.throws(() => runSync(target.config), /Invalid scheduler/);
});

test('Windows PowerShell 5.1 wrapper reads BOM-free UTF-8 paths', { skip: process.platform !== 'win32' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-schedule-utf8-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = path.join(temp, '한국 사용자 경로');
  fs.mkdirSync(fixture);
  const scheduler = path.join(fixture, 'fake scheduler.mjs');
  fs.writeFileSync(scheduler, 'console.log("UTF8_PATH_OK");');
  const wrapper = path.join(temp, 'run.ps1');
  fs.writeFileSync(wrapper, windowsWrapper);
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ node: process.execPath, scheduler }), 'utf8');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UTF8_PATH_OK/);
});
