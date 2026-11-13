// This personal deployment does not send optional anonymous product telemetry.
// Apply before spawning components: a persisted UI choice cannot override it.
export function privateRuntimeEnvironment(env = process.env) {
  return {...env, OCX_TELEMETRY:'0', DO_NOT_TRACK:'1', CAVEMAN_TELEMETRY:'0'};
}
