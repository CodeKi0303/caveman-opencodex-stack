import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runClient} from '../scripts/client-lib.mjs';
import {manualSync} from '../scripts/manual-sync.mjs';

test('configure saves independent manual settings; sync works after scheduler files disappear',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'manual-sync-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const key='synthetic-key-'.repeat(5),keyFile=path.join(home,'key');fs.writeFileSync(keyFile,key);
  const fetchFn=async()=>Response.json({models:[{slug:'fixture',display_name:'Fixture'}]});
  await runClient(['configure','--url','http://localhost:18787/v1','--key-file',keyFile,'--codex-home',home],{fetchFn});
  const saved=fs.readFileSync(path.join(home,'caveman-client.json'),'utf8');
  assert(!saved.includes(key));assert(!fs.existsSync(path.join(home,'caveman-sync-schedule')));
  const before=fs.readFileSync(path.join(home,'config.toml'),'utf8');
  const result=await manualSync(home,{run:args=>runClient(args,{fetchFn})});
  assert.equal(result.catalogChanged,false);assert.match(result.message,/변경이 없습니다/);
  assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'),before);
  fs.writeFileSync(path.join(home,'caveman-client.json'),JSON.stringify({version:1,url:'http://localhost/v1',keyFile,codexHome:path.dirname(home)}));
  await assert.rejects(manualSync(home),error=>error.code==='INVALID_SETTINGS');
});

test('manual sync requires explicit setup and distinguishes changed catalogs',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'manual-sync-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  await assert.rejects(manualSync(home),error=>error.code==='SETUP_REQUIRED');
  fs.writeFileSync(path.join(home,'caveman-client.json'),JSON.stringify({version:1,url:'http://localhost/v1',keyFile:path.join(home,'key'),codexHome:home}));
  const result=await manualSync(home,{run:async()=>({ok:true,catalogChanged:true,restartCodex:true,warnings:[]})});
  assert.match(result.message,/갱신 완료/);assert.match(result.message,/재시작/);
});
