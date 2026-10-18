import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0 ||
      !catalog.models.every(model => typeof model.slug === 'string' && model.slug.length > 0 &&
        typeof model.display_name === 'string')) throw Error('Invalid or empty model catalog');
  if (new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length)
    throw Error('Duplicate model catalog entries');
  return catalog;
}

export async function refreshCatalog({url, output, fetchImpl = fetch, signal}) {
  const response = await fetchImpl(url, {redirect: 'error', signal: signal ?? AbortSignal.timeout(15000)});
  if (!response.ok) throw Error('Catalog upstream HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_CATALOG_BYTES) throw Error('Catalog exceeds size limit');
    chunks.push(chunk);
  }
  const catalog = validateCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const content = JSON.stringify(catalog, null, 2) + '\n';
  let previous;
  try { previous = await fs.readFile(output, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous === content) return {changed: false, models: catalog.models.length};
  await fs.mkdir(path.dirname(output), {recursive: true, mode: 0o700});
  const temporary = output + '.tmp-' + process.pid + '-' + randomUUID();
  try {
    await fs.writeFile(temporary, content, {mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, output);
  } finally { await fs.rm(temporary, {force: true}); }
  return {changed: true, models: catalog.models.length};
}

export async function refreshCatalogAtStartup(options, {attempts = 3, retryMs = 2000, wait = delay} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) throw Error('Invalid startup attempts');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return {ok: true, ...await refreshCatalog(options)}; }
    catch {
      if (attempt === attempts) return {ok: false, last_good_preserved: true};
      await wait(retryMs);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = app.dependencies['@openai/codex'];
  const options = {
    url: 'http://127.0.0.1:10101/v1/models?client_version=' + encodeURIComponent(version),
    output: '/state/catalog/models.json'
  };
  if (process.argv.includes('--once')) {
    try { console.log(JSON.stringify(await refreshCatalog(options))); }
    catch { console.error('Catalog refresh failed; last good file preserved'); process.exitCode = 1; }
  } else console.log(JSON.stringify({event: 'catalog_startup_finished', ...await refreshCatalogAtStartup(options)}));
}
