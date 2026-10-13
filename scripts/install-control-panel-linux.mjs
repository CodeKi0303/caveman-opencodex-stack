import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {systemdQuote} from './install-native-bridge-linux.mjs';

const execute = promisify(execFile);
const unitName = 'caveman-control-panel.service';
const owner = 'caveman-opencodex-stack';
const sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = async file => { try { return await fs.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function parseArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (['--system', '--user'].includes(name)) {
      if (opts.scope) throw Error('Select exactly one of --system and --user.');
      opts.scope = name.slice(2);
    } else if (['--codex-home', '--node-path'].includes(name)) {
      if (opts[name.slice(2)] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw Error(`Missing or repeated ${name}.`);
      opts[name.slice(2)] = argv[++index];
    } else throw Error(`Unknown installer option: ${name}`);
  }
  return {...opts, system: opts.scope === 'system'};
}

export function makePlan(opts, {home = os.homedir(), env = process.env, repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')} = {}) {
  const codexHome = path.resolve(opts['codex-home'] || env.CODEX_HOME || path.join(home, '.codex'));
  const bridgeHome = path.join(codexHome, 'caveman-stack');
  const unitDirectory = opts.system ? '/etc/systemd/system' : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd/user');
  return {...opts, codexHome, bridgeHome, nodePath: path.resolve(opts['node-path'] || process.execPath),
    entryPath: path.join(repo, 'scripts/control-panel.mjs'), configPath: path.join(bridgeHome, 'native-bridge.json'),
    manifestPath: path.join(bridgeHome, 'control-panel-install-linux.json'), unitPath: path.join(unitDirectory, unitName), unitName};
}

export function renderUnit(plan) {
  return `# Managed by ${owner}; local control panel\n[Unit]\nDescription=Caveman local control panel\nAfter=network.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\n` +
    `ExecStart=:${systemdQuote(plan.nodePath)} ${systemdQuote(plan.entryPath)} --config ${systemdQuote(plan.configPath)}\n` +
    'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=15\nKillMode=control-group\nNoNewPrivileges=true\nUMask=0077\n\n[Install]\n' +
    `WantedBy=${plan.system ? 'multi-user.target' : 'default.target'}\n`;
}

async function run(command, args) {
  try { return (await execute(command, args, {timeout: 30000, maxBuffer: 1024 * 1024})).stdout.trim(); }
  catch (error) { throw Error(`${path.basename(command)} ${args[0] ?? ''} failed (${error.code ?? 'unknown'}).`); }
}

export function readPage(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    // Core HTTP intentionally ignores proxy environment variables and does not follow redirects.
    const request = http.get(url, {timeout}, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) response.destroy(Error('Control page is too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(Error(`Control page returned HTTP ${response.statusCode}.`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.on('timeout', () => request.destroy(Error('Control page request timed out.')));
    request.on('error', reject);
  });
}

async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen({port, host: '127.0.0.1', exclusive: true}, () => server.close(() => resolve(true)));
  });
}

// A page marker alone cannot identify a process. Match the kernel socket to systemd's PID.
export async function ownsListeningPort(pid, port, procRoot = '/proc') {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
  try {
    const table = await fs.readFile(path.join(procRoot, 'net/tcp'), 'utf8');
    const listeners = table.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
      .filter(fields => fields[3] === '0A' && parseInt(fields[1].split(':')[1], 16) === port);
    if (listeners.length !== 1 || listeners[0][1].split(':')[0] !== '0100007F') return false;
    const socket = `socket:[${listeners[0][9]}]`;
    const directory = path.join(procRoot, String(pid), 'fd');
    const fds = await fs.readdir(directory);
    return (await Promise.all(fds.map(fd => fs.readlink(path.join(directory, fd)).catch(() => '')))).includes(socket);
  } catch { return false; }
}

export function verifyOwnership(plan, unit, manifest, state) {
  if (state.DropInPaths) throw Error('The control panel unit has external overrides; inspect them before replacing it.');
  if (!unit) {
    if (state.FragmentPath || (state.LoadState && state.LoadState !== 'not-found')) throw Error('A different control panel unit already exists.');
    return false;
  }
  if (!manifest || manifest.managedBy !== owner || manifest.codexHome !== plan.codexHome ||
      manifest.unitPath !== plan.unitPath || manifest.configPath !== plan.configPath || manifest.unitSha256 !== sha(unit) ||
      (state.FragmentPath && state.FragmentPath !== plan.unitPath)) throw Error('The existing control panel unit is not owned by this installer.');
  if (!['enabled', 'disabled', ''].includes(state.UnitFileState ?? '')) throw Error('The existing control panel unit has an unsupported enablement state.');
  return true;
}

export async function installControlPanel(plan, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'linux') throw Error('This installer requires Linux with systemd.');
  if (plan.system && (dependencies.uid ?? process.getuid?.()) !== 0) throw Error('--system must run as root.');
  const command = dependencies.run ?? run, page = dependencies.readPage ?? readPage;
  const available = dependencies.portAvailable ?? portAvailable, ownsPort = dependencies.ownsListeningPort ?? ownsListeningPort;
  const sleep = dependencies.sleep ?? delay;
  let config;
  try { config = JSON.parse(await fs.readFile(plan.configPath, 'utf8')); }
  catch { throw Error('Install the native bridge first; its configuration must be valid JSON.'); }
  const port = config?.controlPort ?? 18786;
  if (!config || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || port === config.port) throw Error('Invalid control or bridge port.');
  const nodeVersion = /^v(\d+)\.(\d+)\.(\d+)$/.exec(await command(plan.nodePath, ['--version']));
  if (!nodeVersion || Number(nodeVersion[1]) < 22 || (Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) < 13)) throw Error('Node.js 22.13 or later is required.');
  if (!(await fs.stat(plan.entryPath)).isFile()) throw Error('The control panel entry must be a file.');
  await command(plan.nodePath, ['--check', plan.entryPath]);
  // Fail before replacing a service when the repository or npm dependencies are incomplete.
  await command(plan.nodePath, ['--input-type=module', '--eval', 'await import(process.argv[1])', pathToFileURL(plan.entryPath).href]);
  const lockPath = path.join(plan.bridgeHome, 'control-panel-install-linux.lock');
  try { await fs.mkdir(lockPath, {mode: 0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw Error('A control panel installation is already in progress; inspect the installer lock before retrying.'); throw error; }
  try { return await installLocked(); }
  finally { await fs.rmdir(lockPath); }

  async function installLocked() {
    const ctl = (...args) => command('systemctl', [...(plan.system ? [] : ['--user']), ...args]);
    const stateOf = async () => Object.fromEntries((await ctl('show', unitName, '--no-pager',
      '--property=LoadState,FragmentPath,DropInPaths,UnitFileState,ActiveState,MainPID')).split('\n').filter(Boolean).map(line => {
        const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
      }));
    const previousState = await stateOf();
    const files = [plan.unitPath, plan.manifestPath];
    for (const file of files) {
      const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && !stat.isFile()) throw Error('Control panel installation paths must be regular files.');
    }
    const before = new Map(await Promise.all(files.map(async file => [file, await read(file)])));
    let manifest = null;
    if (before.get(plan.manifestPath)) {
      try { manifest = JSON.parse(before.get(plan.manifestPath)); } catch { throw Error('The existing control panel ownership record is invalid.'); }
    }
    const owned = verifyOwnership(plan, before.get(plan.unitPath), manifest, previousState);
    if (!(await available(port)) && (!owned || previousState.ActiveState !== 'active' || !(await ownsPort(Number(previousState.MainPID), port)))) {
      throw Error('The requested loopback port is occupied by an unowned process.');
    }
    const backup = path.join(plan.bridgeHome, 'control-panel-backups', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
    await fs.mkdir(backup, {recursive: true, mode: 0o700});
    for (const [file, bytes] of before) if (bytes) await fs.writeFile(path.join(backup, path.basename(file)), bytes, {mode: 0o600});
    await fs.writeFile(path.join(backup, 'service-state.json'), JSON.stringify(previousState, null, 2) + '\n', {mode: 0o600});
    const unit = renderUnit(plan);
    let changed = false, enableAttempted = false, startAttempted = false;
    try {
      if (owned) await ctl('stop', unitName);
      if (!(await available(port))) throw Error('The requested port did not become available.');
      changed = true;
      await fs.mkdir(path.dirname(plan.unitPath), {recursive: true});
      await fs.writeFile(plan.unitPath, unit, {mode: 0o644});
      await fs.writeFile(plan.manifestPath, JSON.stringify({version: 1, managedBy: owner, codexHome: plan.codexHome,
        unitPath: plan.unitPath, unitSha256: sha(unit), nodePath: plan.nodePath, entryPath: plan.entryPath, configPath: plan.configPath}, null, 2) + '\n', {mode: 0o600});
      await ctl('daemon-reload');
      enableAttempted = true;
      await ctl('enable', unitName);
      startAttempted = true;
      await ctl('start', unitName);
      let healthy = false;
      for (let attempt = 0; attempt < (dependencies.readinessAttempts ?? 60); attempt++) {
        const state = await stateOf();
        if (state.ActiveState === 'failed') throw Error('The control panel service failed to start.');
        if (state.ActiveState === 'active' && await ownsPort(Number(state.MainPID), port)) {
          try {
            const html = await page(`http://127.0.0.1:${port}/`, 1000);
            if (/<meta name="control-token" content="[a-f0-9]{64}">/.test(html) && html.includes('Caveman · 로컬 제어실')) { healthy = true; break; }
          } catch { }
        }
        await sleep(500);
      }
      if (!healthy) throw Error('The control panel did not become ready.');
      return {ok: true, service: unitName, scope: plan.system ? 'system' : 'user', url: `http://127.0.0.1:${port}/`, configPath: plan.configPath, backup};
    } catch (error) {
      const restorationErrors = [];
      const restore = async action => { try { await action(); } catch (failure) { restorationErrors.push(failure); } };
      if (changed) {
        if (startAttempted) await restore(() => ctl('stop', unitName));
        if (enableAttempted && (!owned || previousState.UnitFileState !== 'enabled')) await restore(() => ctl('disable', unitName));
        for (const [file, bytes] of before) await restore(() => bytes ? fs.writeFile(file, bytes) : fs.rm(file, {force: true}));
        await restore(() => ctl('daemon-reload'));
        if (owned && previousState.UnitFileState === 'enabled') await restore(() => ctl('enable', unitName));
      }
      if (owned && ['active', 'activating', 'reloading'].includes(previousState.ActiveState)) await restore(() => ctl('start', unitName));
      if (restorationErrors.length) throw Error(`${error.message} Automatic restoration was incomplete; inspect ${backup}.`);
      throw Error(`${error.message} Previous installation restored; backup: ${backup}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await installControlPanel(makePlan(parseArgs(process.argv.slice(2)))), null, 2)); }
  catch (error) { console.error(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1; }
}
