import {readFileSync, mkdirSync, copyFileSync, chmodSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const modes = new Set(['pool', 'direct']);

// Run inside the container. The admin key and config never leave its private mounts.
export async function accountMode({mode, adminKey, configDir = '/state/opencodex',
  baseUrl = 'http://127.0.0.1:10100', fetchImpl = fetch} = {}) {
  if (mode !== undefined && !modes.has(mode)) throw Error('Account mode must be pool or direct');
  if (typeof adminKey !== 'string' || !adminKey.trim()) throw Error('Admin key is unavailable');
  async function api(path, method = 'GET', body) {
    let response;
    try {
      response = await fetchImpl(baseUrl + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {authorization: 'Bearer ' + adminKey.trim(), 'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
    } catch { throw Error('OpenCodex management API is unavailable'); }
    // Never echo management bodies, which may contain private configuration.
    if (!response.ok) throw Error(`OpenCodex management API returned HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw Error('OpenCodex management API returned invalid JSON'); }
  }
  async function currentMode() {
    const providers = await api('/api/providers');
    const current = Array.isArray(providers) && providers.find(p => p.name === 'openai');
    if (!current || !modes.has(current.codexAccountMode))
      throw Error('OpenCodex did not report a supported OpenAI account mode');
    return current.codexAccountMode;
  }
  const previousMode = await currentMode();
  if (mode === undefined || mode === previousMode)
    return {provider: 'openai', mode: previousMode, changed: false};

  const backup = join(configDir, 'account-mode-backups', Date.now() + '-' + randomUUID());
  mkdirSync(backup, {recursive: true, mode: 0o700});
  copyFileSync(join(configDir, 'config.json'), join(backup, 'config.json'));
  chmodSync(join(backup, 'config.json'), 0o600);
  writeFileSync(join(backup, 'change.json'), JSON.stringify({previousMode, requestedMode: mode,
    rollbackCommand: './stack account-mode ' + previousMode}, null, 2) + '\n', {mode: 0o600});
  // The upstream PATCH persists atomically and clears quota/thread selection caches.
  // Editing config.json directly would leave the running server in its old mode.
  await api('/api/providers?name=openai', 'PATCH', {codexAccountMode: mode});
  if (await currentMode() !== mode)
    throw Error('Account mode verification failed; inspect the saved change.json before retrying');
  return {provider: 'openai', mode, previousMode, changed: true, backup};
}

if (process.argv[1] === '-' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw Error('Usage: account-mode.mjs [pool|direct]');
    const result = await accountMode({mode: process.argv[2],
      adminKey: readFileSync('/run/secrets/admin-key', 'utf8')});
    console.log(JSON.stringify(result));
  } catch (error) {
    // Filesystem failures can include private paths; do not dump stacks or credentials.
    console.error(error?.code ? 'Account mode operation failed; check private state and secret mounts' : error.message);
    process.exitCode = 1;
  }
}
