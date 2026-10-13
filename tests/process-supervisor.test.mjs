import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {superviseComponents} from '../src/process-supervisor.mjs';

function fixture({deny = false, missing = false} = {}) {
  const children = [], logs = [], exits = [];
  let timeout, cleared = false;
  const supervisor = superviseComponents([
    {name: 'gateway', command: 'gateway'},
    {name: 'caveman', command: 'caveman'},
    {name: 'catalog', command: 'catalog', required: false}
  ], {
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = missing && !children.length ? undefined : children.length + 1;
      child.signals = [];
      child.kill = signal => {
        child.signals.push(signal);
        if (deny) child.emit('error', Object.assign(new Error('private message'), {code: 'EACCES', syscall: 'kill'}));
      };
      children.push(child);
      return child;
    },
    log: value => logs.push(value), exit: code => exits.push(code),
    setTimer: callback => { timeout = callback; return {}; }, clearTimer: () => { cleared = true; }
  });
  return {supervisor, children, logs, exits, force: () => timeout(), wasCleared: () => cleared};
}

test('AppArmor-style denied TERM and KILL are bounded, labeled, and never unhandled', () => {
  const f = fixture({deny: true});
  assert.doesNotThrow(() => f.supervisor.stop(0, 'SIGTERM'));
  assert.doesNotThrow(() => f.force());
  assert.deepEqual(f.exits, [1]);
  for (const child of f.children) assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.logs.filter(x => x.event === 'component_stop_error').length, 6);
  assert.equal(f.logs.some(x => x.event === 'component_start_failed'), false);
  assert.equal(JSON.stringify(f.logs).includes('private message'), false);
});

test('required spawn failure shuts down siblings and does not wait for nonexistent PID', () => {
  const f = fixture({missing: true});
  f.children[0].emit('error', Object.assign(Error('binary missing'), {code: 'ENOENT', syscall: 'spawn'}));
  for (const child of f.children.slice(1)) child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.children[0].signals, []);
  assert.equal(f.wasCleared(), true);
  assert.deepEqual(f.logs[0], {event: 'component_start_failed', component: 'gateway', code: 'ENOENT', syscall: 'spawn'});
});

test('optional catalog completion does not stop the stack; signal exits settle shutdown', () => {
  const f = fixture();
  f.children[2].emit('exit', 0, null);
  assert.deepEqual(f.exits, []);
  f.supervisor.stop(0, 'SIGTERM');
  f.supervisor.stop(1, 'duplicate');
  f.children[0].emit('exit', null, 'SIGTERM');
  f.children[1].emit('exit', null, 'SIGTERM');
  f.children[1].emit('close');
  assert.deepEqual(f.exits, [0]);
  assert.deepEqual(f.children[2].signals, []);
  assert.equal(f.wasCleared(), true);
});

test('unexpected required exit stops remaining components and retains failure status', () => {
  const f = fixture();
  f.children[1].emit('exit', 42, null);
  f.children[0].emit('exit', null, 'SIGTERM');
  f.children[2].emit('close');
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.children[1].signals, []);
  assert.equal(f.logs.find(x => x.event === 'stack_stopping').reason, 'component_exit');
});
