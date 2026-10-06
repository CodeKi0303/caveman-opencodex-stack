import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const execute = promisify(execFile);
const unitName = 'caveman-native-bridge.service';
const owner = 'caveman-opencodex-stack';
const sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = async file => { try { return await fs.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function systemdQuote(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid control character in a service path.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
}

export function renderUnit(plan) {
  return `# Managed by ${owner}; native OpenAI bridge\n[Unit]\nDescription=Caveman native OpenAI bridge\nAfter=network.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\n` +
    // The ':' executable prefix disables systemd's $VARIABLE substitution.
    `ExecStart=:${systemdQuote(plan.nodePath)} ${systemdQuote(plan.bridgePath)} --config ${systemdQuote(plan.configPath)}\n` +
    'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=15\nKillMode=control-group\nNoNewPrivileges=true\nUMask=0077\n\n[Install]\n' +
    `WantedBy=${plan.system ? 'multi-user.target' : 'default.target'}\n`;
}

export function parseArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (['--system', '--user'].includes(name)) { if (opts.scope) throw Error('Select exactly one of --system and --user.'); opts.scope = name.slice(2); }
    else if (['--codex-home', '--upstream-url', '--key-file', '--port', '--node-path'].includes(name)) {
      if (opts[name.slice(2)] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw Error(`Missing or repeated ${name}.`);
      opts[name.slice(2)] = argv[++index];
    } else throw Error(`Unknown installer option: ${name}`);
  }
  if (!opts['upstream-url'] || !opts['key-file']) throw Error('--upstream-url and --key-file are required.');
  const upstream = new URL(opts['upstream-url']);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash ||
      !['/v1', '/v1/'].includes(upstream.pathname)) throw Error('Upstream must be an HTTP(S) /v1 URL without credentials, query or fragment.');
  upstream.pathname = '/v1';
  const port = Number(opts.port ?? 18788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Port must be between 1024 and 65535.');
  return {...opts, system: opts.scope === 'system', upstreamUrl: upstream.href, port};
}

export function makePlan(opts, {home = os.homedir(), env = process.env, repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')} = {}) {
  const codexHome = path.resolve(opts['codex-home'] || env.CODEX_HOME || path.join(home, '.codex'));
  const bridgeHome = path.join(codexHome, 'caveman-stack');
  const unitDirectory = opts.system ? '/etc/systemd/system' : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd/user');
  return {...opts, codexHome, bridgeHome, nodePath: path.resolve(opts['node-path'] || process.execPath),
    keyFile: path.resolve(opts['key-file']), sourceBridgePath: path.join(repo, 'src/native-bridge.mjs'), bridgePath: path.join(bridgeHome, 'native-bridge.mjs'),
    configPath: path.join(bridgeHome, 'native-bridge.json'), manifestPath: path.join(bridgeHome, 'native-bridge-install-linux.json'),
    unitPath: path.join(unitDirectory, unitName), unitName};
}

async function run(command, args) {
  try { return (await execute(command, args, {timeout: 30000, maxBuffer: 1024 * 1024})).stdout.trim(); }
  catch (error) { throw Error(`${path.basename(command)} ${args[0] ?? ''} failed (${error.code ?? 'unknown'}).`); }
}

export function readJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    // Core http.request never inherits proxy environment variables.
    const request = http.get(url, {timeout}, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) response.destroy(Error('Bridge JSON response is too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(Error(`Bridge returned HTTP ${response.statusCode}.`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('Bridge response is not JSON.')); }
      });
    });
    request.on('timeout', () => request.destroy(Error('Bridge request timed out.')));
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

export function verifyOwnership(plan, unit, manifest, state, bridge) {
  if (state.DropInPaths) throw Error('The bridge unit has external overrides; inspect them before replacing it.');
  if (!unit) {
    if (state.FragmentPath || (state.LoadState && state.LoadState !== 'not-found')) throw Error('A different bridge unit already exists.');
    return false;
  }
  if (!manifest || manifest.managedBy !== owner || manifest.codexHome !== plan.codexHome ||
      manifest.unitPath !== plan.unitPath || manifest.unitSha256 !== sha(unit) ||
      !bridge || manifest.bridgeSha256 !== sha(bridge) || manifest.bridgePath !== plan.bridgePath ||
      (state.FragmentPath && state.FragmentPath !== plan.unitPath)) throw Error('The existing bridge unit is not owned by this installer.');
  if (!['enabled', 'disabled', ''].includes(state.UnitFileState ?? '')) throw Error('The existing bridge unit has an unsupported enablement state.');
  return true;
}

export async function installBridge(plan, dependencies = {}) {
  const command = dependencies.run ?? run, json = dependencies.readJson ?? readJson;
  const available = dependencies.portAvailable ?? portAvailable, sleep = dependencies.sleep ?? delay;
  if ((dependencies.platform ?? process.platform) !== 'linux') throw Error('This installer requires Linux with systemd.');
  if (plan.system && (dependencies.uid ?? process.getuid?.()) !== 0) throw Error('--system must run as root.');
  const nodeVersion = await command(plan.nodePath, ['--version']);
  const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 13)) throw Error('Node.js 22.13 or later is required.');
  for (const file of [plan.keyFile, plan.sourceBridgePath]) if (!(await fs.stat(file)).isFile()) throw Error('The key and bridge entry paths must be files.');
  await command(plan.nodePath, ['--check', plan.sourceBridgePath]);
  const bridge = await fs.readFile(plan.sourceBridgePath);
  const key = (await fs.readFile(plan.keyFile, 'utf8')).trim();
  if (key.length < 32 || /[\r\n]/.test(key)) throw Error('The gateway key file is invalid.');
  const ctl = (...args) => command('systemctl', [...(plan.system ? [] : ['--user']), ...args]);
  const stateOf = async () => Object.fromEntries((await ctl('show', unitName, '--no-pager',
    '--property=LoadState,FragmentPath,DropInPaths,UnitFileState,ActiveState,MainPID')).split('\n').filter(Boolean).map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
  const previousState = await stateOf();
  const files = [plan.unitPath, plan.configPath, plan.manifestPath, plan.bridgePath];
  const before = new Map(await Promise.all(files.map(async file => [file, await read(file)])));
  let manifest = null;
  if (before.get(plan.manifestPath)) {
    try { manifest = JSON.parse(before.get(plan.manifestPath)); } catch { throw Error('The existing bridge ownership record is invalid.'); }
  }
  const owned = verifyOwnership(plan, before.get(plan.unitPath), manifest, previousState, before.get(plan.bridgePath));
  if (!(await available(plan.port))) {
    let health; try { health = await json(`http://127.0.0.1:${plan.port}/healthz`); } catch { }
    if (!owned || previousState.ActiveState !== 'active' || !health || health.service !== 'caveman-native-bridge' ||
        Number(health.pid) !== Number(previousState.MainPID) || Number(health.pid) < 1) throw Error('The requested loopback port is occupied by an unowned process.');
  }
  const backup = path.join(plan.bridgeHome, 'native-bridge-backups', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
  await fs.mkdir(backup, {recursive: true, mode: 0o700});
  for (const [file, bytes] of before) if (bytes) await fs.writeFile(path.join(backup, path.basename(file)), bytes, {mode: 0o600});
  await fs.writeFile(path.join(backup, 'service-state.json'), JSON.stringify(previousState, null, 2) + '\n', {mode: 0o600});
  const unit = renderUnit(plan);
  const config = JSON.stringify({upstreamUrl: plan.upstreamUrl, keyFile: plan.keyFile, port: plan.port}, null, 2) + '\n';
  let changed = false, enableAttempted = false, startAttempted = false;
  try {
    if (owned) await ctl('stop', unitName);
    if (!(await available(plan.port))) throw Error('The requested port did not become available.');
    changed = true;
    await fs.mkdir(path.dirname(plan.unitPath), {recursive: true});
    await fs.writeFile(plan.configPath, config, {mode: 0o600});
    await fs.writeFile(plan.bridgePath, bridge, {mode: 0o600});
    await fs.writeFile(plan.unitPath, unit, {mode: 0o644});
    await fs.writeFile(plan.manifestPath, JSON.stringify({version: 1, managedBy: owner, codexHome: plan.codexHome,
      unitPath: plan.unitPath, unitSha256: sha(unit), nodePath: plan.nodePath, bridgePath: plan.bridgePath, bridgeSha256: sha(bridge), configPath: plan.configPath}, null, 2) + '\n', {mode: 0o600});
    await ctl('daemon-reload');
    enableAttempted = true;
    await ctl('enable', unitName);
    startAttempted = true;
    await ctl('start', unitName);
    let healthy = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await stateOf();
      if (state.ActiveState === 'failed') throw Error('The bridge service failed to start.');
      try {
        const health = await json(`http://127.0.0.1:${plan.port}/healthz`, 1000);
        if (health.service === 'caveman-native-bridge' && health.ok === true && health.upstreamUrl === plan.upstreamUrl &&
            Number(health.pid) > 0 && Number(health.pid) === Number(state.MainPID)) { healthy = true; break; }
      } catch { }
      await sleep(250);
    }
    if (!healthy) throw Error('The bridge did not become healthy within 30 seconds.');
    const catalog = await json(`http://127.0.0.1:${plan.port}/v1/catalog`, 15000);
    if (!Array.isArray(catalog.models) || !catalog.models.length || catalog.models.some(model => !model || typeof model.slug !== 'string' || !model.slug.trim()) ||
        new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length) throw Error('The bridge catalog is invalid or empty.');
    return {ok: true, service: unitName, scope: plan.system ? 'system' : 'user', bridgeUrl: `http://127.0.0.1:${plan.port}/v1`,
      upstreamUrl: plan.upstreamUrl, configPath: plan.configPath, models: catalog.models.length, backup};
  } catch (error) {
    const restorationErrors = [];
    const restore = async action => { try { await action(); } catch (failure) { restorationErrors.push(failure); } };
    if (changed) {
      if (startAttempted) await restore(() => ctl('stop', unitName));
      if (enableAttempted && (!owned || previousState.UnitFileState !== 'enabled')) await restore(() => ctl('disable', unitName));
      for (const [file, bytes] of before) {
        await restore(() => bytes ? fs.writeFile(file, bytes) : fs.rm(file, {force: true}));
      }
      await restore(() => ctl('daemon-reload'));
      if (owned && previousState.UnitFileState === 'enabled') await restore(() => ctl('enable', unitName));
    }
    if (owned && ['active', 'activating', 'reloading'].includes(previousState.ActiveState)) await restore(() => ctl('start', unitName));
    if (restorationErrors.length) throw Error(`${error.message} Automatic restoration was incomplete; inspect ${backup}.`);
    throw Error(`${error.message} Previous installation restored; backup: ${backup}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await installBridge(makePlan(parseArgs(process.argv.slice(2)))), null, 2)); }
  catch (error) { console.error(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1; }
}
