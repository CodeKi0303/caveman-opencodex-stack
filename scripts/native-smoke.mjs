#!/usr/bin/env node
// Opt-in native Codex check. A private temporary home keeps production history intact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runClient} from './client-lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const name of ['codex-bin', 'auth-file', 'url', 'key-file', 'bridge-url']) {
  if (!args[name]) throw new Error(`Missing --${name}`);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-native-smoke-'));
const authFile = path.join(home, 'auth.json');
const outputFile = path.join(home, 'answer.txt');
const model = args.model || 'gpt-6.1-sol';
let result;
try {
  fs.copyFileSync(args['auth-file'], authFile, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(authFile, 0o600);
  await runClient(['configure', '--provider', 'openai', '--url', args.url, '--key-file', args['key-file'],
    '--bridge-url', args['bridge-url'], '--codex-home', home]);
  const command = ['exec', '--skip-git-repo-check', '--ignore-rules', '--sandbox', 'read-only',
    '-C', home, '-m', model, '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers.caveman.enabled=false',
    '--color', 'never', '--output-last-message', outputFile,
    'Reply exactly NATIVE_OPENAI_OK. Do not call tools.'];
  const env = {...process.env, CODEX_HOME: home};
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_API_KEY;
  const started = Date.now();
  result = await new Promise((resolve, reject) => {
    const child = spawn(args['codex-bin'], command, {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let diagnostic = '';
    const collect = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-32768); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), 180000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); resolve({code, diagnostic}); });
  });
  const answer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').trim() : '';
  const providers = new Set();
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.jsonl')) {
        const line = fs.readFileSync(file, 'utf8').split('\n')[0];
        try { const meta = JSON.parse(line); if (meta.type === 'session_meta') providers.add(meta.payload.model_provider); } catch {}
      }
    }
  };
  walk(path.join(home, 'sessions'));
  const ok = result.code === 0 && answer === 'NATIVE_OPENAI_OK' && providers.size === 1 && providers.has('openai');
  // These diagnostics contain booleans only; never echo request headers or native output.
  console.log(JSON.stringify({ok, native_exit: result.code, answer_ok: answer === 'NATIVE_OPENAI_OK',
    saved_provider: [...providers], elapsed_ms: Date.now() - started, requested_model: model,
    websocket_fallback: /[Ff]alling back.*WebSocket|WebSocket.*[Ff]alling back|WebSocket.*fallback/.test(result.diagnostic),
    unauthorized: /401 Unauthorized|403 Forbidden/.test(result.diagnostic),
    config_error: /[Ee]rror.*config|[Ii]nvalid.*config/.test(result.diagnostic)}));
  if (!ok) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ok: false, error: 'Native smoke check failed; no credentials included.'}));
  process.exitCode = 1;
} finally {
  // Remove the temporary auth and config copies containing gateway credentials.
  // The test directory is created by mkdtemp above and never supplied by the caller.
  const resolved = path.resolve(home);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('caveman-native-smoke-'))
    throw new Error('Unexpected temporary path; cleanup refused');
  fs.rmSync(resolved, {recursive: true, force: true});
}
