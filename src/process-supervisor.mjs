import {spawn} from 'node:child_process';

// ChildProcess emits `error` for failed signals as well as failed spawns. Keep
// the listener installed through shutdown: a second denied signal must not
// become an unhandled error and hide the original shutdown reason.
export function superviseComponents(components, {
  env = process.env, spawnImpl = spawn,
  log = value => console.error(JSON.stringify(value)),
  exit = code => process.exit(code),
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 12000
} = {}) {
  const children = [];
  let stopping = false, finished = false, exitCode = 0, timer;
  const safeField = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(value) ? value : undefined;
  const report = (event, component, error) => log({event, component,
    ...(safeField(error?.code) ? {code: error.code} : {}),
    ...(safeField(error?.syscall) ? {syscall: error.syscall} : {})});
  function finish() {
    if (finished) return;
    finished = true;
    if (timer) clearTimer(timer);
    exit(exitCode);
  }
  function checkStopped() {
    if (stopping && children.every(child => child.ended)) finish();
  }
  function signal(child, value) {
    if (child.ended || !child.process.pid) return;
    try { child.process.kill(value); }
    catch (error) { child.onError(error); }
  }
  function stop(code = 0, reason = 'requested') {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    log({event: 'stack_stopping', reason, code});
    timer = setTimer(() => {
      for (const child of children) signal(child, 'SIGKILL');
      finish();
    }, timeoutMs);
    // Keep this timer referenced: a failed spawn may never emit `exit`, and a
    // denied SIGTERM must still reach the bounded forced-shutdown path.
    for (const child of children) signal(child, 'SIGTERM');
    checkStopped();
  }
  for (const {name, command, args = [], required = true} of components) {
    if (stopping) break;
    const child = {name, ended: false};
    children.push(child);
    child.onError = error => {
      if (stopping) {
        report('component_stop_error', name, error);
        exitCode ||= 1;
        return;
      }
      // A missing executable has no PID and emits `close`, not `exit`.
      if (!child.process?.pid) child.ended = true;
      report(child.ended ? 'component_start_failed' : 'component_error', name, error);
      if (required) stop(1, 'component_error');
    };
    try {
      child.process = spawnImpl(command, args, {env, stdio: ['ignore', 'inherit', 'inherit']});
    } catch (error) {
      child.onError(error);
      continue;
    }
    child.process.on('error', child.onError);
    child.process.once('exit', (code, signal) => {
      child.ended = true;
      log({event: 'component_exited', component: name, code, signal});
      if (required && !stopping) stop(1, 'component_exit');
      checkStopped();
    });
    child.process.once('close', () => { child.ended = true; checkStopped(); });
  }
  return {stop};
}
