#!/usr/bin/env node
// Node >=22.13. No credentials or server response bodies are printed.
import {runClient, ClientError} from './client-lib.mjs';
try {
  const result = await runClient(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ok:false,
    error:error instanceof ClientError ? error.code : 'CLIENT_FAILED',
    message:error instanceof ClientError ? error.message : 'Client operation failed. No credential values are included in this diagnostic.'}));
  process.exitCode = 1;
}
