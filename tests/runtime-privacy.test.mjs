import test from 'node:test';
import assert from 'node:assert/strict';
import {privateRuntimeEnvironment} from '../src/runtime-privacy.mjs';
import {readFileSync} from 'node:fs';

// Exercise the exact consent gate shipped by the pinned OpenCodex dependency.
const source=readFileSync(new URL('../node_modules/@bitkyc08/opencodex/src/telemetry/consent.ts',import.meta.url),'utf8');
const {stripTypeScriptTypes}=await import('node:module');
const gate=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
test('container privacy overrides accepted consent and the anonymous telemetry notice default',()=>{
  const incoming={OCX_TELEMETRY:'1',DO_NOT_TRACK:'0',CAVEMAN_TELEMETRY:'1',HTTPS_PROXY:'preserved'};
  const env=privateRuntimeEnvironment(incoming);
  assert.equal(env.HTTPS_PROXY,'preserved');assert.equal(incoming.OCX_TELEMETRY,'1');
  assert.equal(env.CAVEMAN_TELEMETRY,'0');
  for(const telemetry of [undefined,{decision:'accepted'},{noticeShownAt:'2026-11-13T00:00:00Z'}]){
    const status=gate.resolveTelemetryStatus({telemetry},env);
    assert.equal(status.effective,false);assert.equal(status.envOverride,'OCX_TELEMETRY');
  }
  assert.equal(gate.resolveTelemetryStatus({telemetry:{decision:'accepted'}},{DO_NOT_TRACK:'1'}).effective,false);
});
