// Opt-in, per-user catalog synchronization. Importing this module never installs a task.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ownFile = fileURLToPath(import.meta.url);
const owner = 'caveman-opencodex-stack catalog sync';
const usage = 'schedule.mjs install --url http(s)://host:18787/v1 --key-file FILE [--codex-home DIR] [--interval-minutes 15]\n       schedule.mjs status|remove [--codex-home DIR]';

export function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['install', 'remove', 'status', 'run'].includes(command)) throw Error(usage);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !args[i + 1] || !['url', 'key-file', 'codex-home', 'interval-minutes', 'config'].includes(name) || name in options) throw Error(usage);
    options[name] = args[i + 1];
  }
  const allowed = command === 'install' ? ['url', 'key-file', 'codex-home', 'interval-minutes'] : command === 'run' ? ['config'] : ['codex-home'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw Error(usage);
  return { command, options };
}

function plain(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw Error('Paths and URLs must not contain control characters');
  return value;
}

export function layout(options = {}, platform = process.platform, env = process.env) {
  if (!['win32', 'linux'].includes(platform)) throw Error('Scheduling supports Windows and Linux/WSL with user systemd');
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = p.resolve(plain(options['codex-home'] || env.CODEX_HOME || p.join(os.homedir(), '.codex')));
  const identity = platform === 'win32' ? home.toLowerCase() : home;
  const id = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  const name = 'caveman-catalog-sync-' + id;
  const stateDir = p.join(home, 'caveman-sync-schedule');
  return {
    platform, home, name, marker: owner + ':' + id, stateDir,
    config: p.join(stateDir, 'config.json'), wrapper: p.join(stateDir, 'run.ps1'),
    log: p.join(stateDir, 'last-run.json'),
    unitsDir: platform === 'linux' ? p.join(env.XDG_CONFIG_HOME || p.join(os.homedir(), '.config'), 'systemd', 'user') : null,
  };
}

export function makeConfig(options, target, node = process.execPath, script = ownFile) {
  if (!options.url || !options['key-file']) throw Error(usage);
  const url = new URL(plain(options.url));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Use an HTTP(S) URL without credentials, query, or fragment');
  const intervalMinutes = Number(options['interval-minutes'] || 15);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || 60 % intervalMinutes !== 0) throw Error('Interval must be a positive divisor of 60 minutes (for example 5, 15, 30, or 60)');
  const p = target.platform === 'win32' ? path.win32 : path.posix;
  return { owner: target.marker, url: url.href.replace(/\/$/, ''), keyFile: p.resolve(plain(options['key-file'])), codexHome: target.home, intervalMinutes, node: p.resolve(plain(node)), scheduler: p.resolve(plain(script)), client: p.join(p.dirname(script), 'client.mjs') };
}

export function syncArguments(config) {
  return [config.client, 'sync', '--url', config.url, '--key-file', config.keyFile, '--codex-home', config.codexHome];
}

const ps = value => "'" + plain(value).replaceAll("'", "''") + "'";
// CommandLineToArgvW quoting, for the Task Scheduler action's native command line.
export const windowsArgument = value => '"' + plain(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export const windowsWrapper = `$ErrorActionPreference = 'Stop'
$configFile = Join-Path $PSScriptRoot 'config.json'
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
& $config.node $config.scheduler run --config $configFile
exit $LASTEXITCODE
`;

export function windowsCommand(command, target, config) {
  const prelude = `$ErrorActionPreference = 'Stop'\n$name = ${ps(target.name)}\n$marker = ${ps(target.marker)}\n$task = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue\nif ($task -and $task.Description -ne $marker) { throw 'Refusing to modify a task not owned by this installer' }\n`;
  if (command === 'status') return prelude + `if (!$task) { @{ installed = $false; name = $name } | ConvertTo-Json -Compress; exit 0 }
$info = Get-ScheduledTaskInfo -TaskName $name -TaskPath '\\'
@{ installed = $true; name = $name; state = [string]$task.State; lastResult = $info.LastTaskResult; lastRun = $info.LastRunTime.ToString('o'); nextRun = $info.NextRunTime.ToString('o') } | ConvertTo-Json -Compress
`;
  if (command === 'remove') return prelude + `if ($task) {
  if ([string]$task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name -TaskPath '\\' }
  Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false
}\n`;
  if (command !== 'install') throw Error('Invalid scheduler operation');
  const actionArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + windowsArgument(target.wrapper);
  return prelude + `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ${ps(actionArgs)}
$login = New-ScheduledTaskTrigger -AtLogOn -User $identity
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${config.intervalMinutes})
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger @($login, $periodic) -Settings $settings -Principal $principal -Description $marker -Force | Out-Null
`;
}

export function systemdArgument(value) {
  return '"' + plain(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}

export function systemdUnits(target, config) {
  const command = [config.node, config.scheduler, 'run', '--config', target.config].map(systemdArgument).join(' ');
  const calendar = config.intervalMinutes === 60 ? '*-*-* *:00:00' : `*-*-* *:00/${config.intervalMinutes}:00`;
  return {
    service: `# ${target.marker}\n[Unit]\nDescription=Caveman client catalog synchronization\n\n[Service]\nType=oneshot\nExecStart=${command}\nTimeoutStartSec=90\nUMask=0077\n`,
    timer: `# ${target.marker}\n[Unit]\nDescription=Caveman client catalog synchronization timer\n\n[Timer]\nOnStartupSec=30s\nOnCalendar=${calendar}\nPersistent=true\nRandomizedDelaySec=15s\nUnit=${target.name}.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error((result.stderr || result.stdout || command + ' failed').trim());
  return result.stdout.trim();
}

function powershell(source, exec) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exec(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
}

function assertState(target) {
  if (!fs.existsSync(target.stateDir)) return;
  if (fs.lstatSync(target.stateDir).isSymbolicLink()) throw Error('Refusing a symlinked scheduler state directory');
  if (!fs.existsSync(target.config)) throw Error('Scheduler directory lacks its ownership record; inspect it manually');
  if (fs.lstatSync(target.config).isSymbolicLink() || JSON.parse(fs.readFileSync(target.config, 'utf8')).owner !== target.marker) throw Error('Scheduler state belongs to another installer');
}

function assertUnits(target) {
  for (const suffix of ['service', 'timer']) {
    const file = path.join(target.unitsDir, target.name + '.' + suffix);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.readFileSync(file, 'utf8').startsWith('# ' + target.marker + '\n'))) throw Error('Refusing to modify an unowned systemd unit: ' + file);
  }
}

function atomic(file, contents) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Refusing a symlink: ' + file);
  const temp = file + '.tmp-' + process.pid;
  try { fs.writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function manage(command, options, { platform = process.platform, env = process.env, exec = execute, node = process.execPath, script = ownFile } = {}) {
  const target = layout(options, platform, env);
  assertState(target);
  if (platform === 'linux') assertUnits(target);
  const service = target.name + '.service', timer = target.name + '.timer';
  if (command === 'status') {
    if (platform === 'win32') return JSON.parse(powershell(windowsCommand('status', target), exec));
    const installed = fs.existsSync(path.join(target.unitsDir, timer));
    return { installed, name: target.name, ...(installed ? { status: exec('systemctl', ['--user', 'show', timer, '--property=ActiveState,UnitFileState,LastTriggerUSec,NextElapseUSecRealtime']) } : {}) };
  }
  if (command === 'remove') {
    if (platform === 'win32') powershell(windowsCommand('remove', target), exec);
    else if (fs.existsSync(path.join(target.unitsDir, timer)) || fs.existsSync(path.join(target.unitsDir, service))) {
      exec('systemctl', ['--user', 'disable', '--now', timer]);
      exec('systemctl', ['--user', 'stop', service]);
      for (const file of [service, timer]) if (fs.existsSync(path.join(target.unitsDir, file))) fs.unlinkSync(path.join(target.unitsDir, file));
      exec('systemctl', ['--user', 'daemon-reload']);
    }
    // Only known files under the resolved, checked state directory are removed.
    for (const file of [target.config, target.wrapper, target.log]) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(target.stateDir) && fs.readdirSync(target.stateDir).length === 0) fs.rmdirSync(target.stateDir);
    return { installed: false, name: target.name };
  }
  if (command !== 'install') throw Error(usage);
  const config = makeConfig(options, target, node, script);
  for (const file of [config.node, config.scheduler, config.client, config.keyFile]) if (!fs.statSync(file).isFile()) throw Error('Expected a file: ' + file);
  // Preflight before writing any files or changing a scheduler.
  if (platform === 'win32') powershell(windowsCommand('status', target), exec);
  else {
    try { exec('systemctl', ['--user', 'show-environment']); }
    catch { throw Error('A running user systemd manager is required. Enable systemd in WSL and start a user session before installing.'); }
  }
  fs.mkdirSync(target.stateDir, { recursive: true, mode: 0o700 });
  atomic(target.config, JSON.stringify(config, null, 2) + '\n');
  if (platform === 'win32') {
    atomic(target.wrapper, windowsWrapper);
    powershell(windowsCommand('install', target, config), exec);
  } else {
    const units = systemdUnits(target, config);
    fs.mkdirSync(target.unitsDir, { recursive: true, mode: 0o700 });
    atomic(path.join(target.unitsDir, service), units.service);
    atomic(path.join(target.unitsDir, timer), units.timer);
    exec('systemctl', ['--user', 'daemon-reload']);
    exec('systemctl', ['--user', 'enable', '--now', timer]);
    exec('systemctl', ['--user', 'restart', timer]);
  }
  return { installed: true, name: target.name, intervalMinutes: config.intervalMinutes, codexHome: target.home, lastRunFile: target.log };
}

export function runSync(configFile) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const target = layout({ 'codex-home': config.codexHome });
  if (path.resolve(configFile) !== target.config || config.owner !== target.marker) throw Error('Invalid scheduler configuration');
  const result = spawnSync(config.node, syncArguments(config), { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  const code = result.error ? 1 : result.status ?? 1;
  atomic(target.log, JSON.stringify({ at: new Date().toISOString(), exitCode: code, output: (result.stdout || '').slice(-16000), error: result.error?.message || (result.stderr || '').slice(-16000) }, null, 2) + '\n');
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownFile) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === 'run') { if (!options.config) throw Error(usage); process.exitCode = runSync(options.config); }
    else console.log(JSON.stringify(manage(command, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
