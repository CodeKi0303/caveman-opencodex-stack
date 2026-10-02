import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

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

export async function runCatalogWorker(options, {intervalSeconds = 900, log = console.log} = {}) {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60)
    throw Error('CATALOG_REFRESH_SECONDS must be an integer of at least 60');
  let stopping = false;
  let wake;
  let controller;
  const stop = () => { stopping = true; controller?.abort(); wake?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopping) {
      controller = new AbortController();
      let failed = false;
      try {
        const result = await refreshCatalog({...options,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])});
        if (result.changed) log(JSON.stringify({event: 'catalog_refreshed', ...result}));
      } catch {
        failed = true;
        if (!stopping) log(JSON.stringify({event: 'catalog_refresh_failed', last_good_preserved: true}));
      }
      if (!stopping) await new Promise(resolve => {
        const timer = setTimeout(resolve, (failed ? Math.min(intervalSeconds, 30) : intervalSeconds) * 1000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
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
  } else await runCatalogWorker(options, {intervalSeconds: Number(process.env.CATALOG_REFRESH_SECONDS || 900)});
}
