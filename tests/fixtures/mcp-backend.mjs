// Deliberately implements the older stdio protocol used by Caveman, without SDK helpers.
import {createInterface} from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let initialized = false;
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (process.env.FIXTURE_INIT_MODE === 'hang') continue;
    send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});
  } else if (message.method === 'notifications/initialized') {
    initialized = true;
  } else if (message.method === 'tools/call') {
    if (!initialized || message.params.name !== 'caveman_retrieve') process.exit(3);
    const {recovery_handle:handle, query} = message.params.arguments;
    if (handle === 'crash') process.exit(4);
    if (handle === 'hang') continue;
    if (handle === 'pid') {
      send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:String(process.pid)}]}});
      continue;
    }
    if (handle === 'operating-environment') {
      send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({
        offline:process.env.CAVEMAN_OFFLINE ?? null, telemetry:process.env.CAVEMAN_TELEMETRY ?? null
      })}]}});
      continue;
    }
    if (handle === 'exact') {
      send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'원문\r\n  retained\tspaces\n'}]}});
      continue;
    }
    const result = handle === 'unknown'
      ? {isError:true,content:[{type:'text',text:'cave_unknown_handle: no original found for handle'}]}
      : {content:[{type:'text',text:JSON.stringify({handle,query:query ?? null,
        extraKeys:Object.keys(message.params.arguments).filter(key=>!['recovery_handle','query'].includes(key)),
        authEnv:process.env.HTTP_AUTHORIZATION ?? null})}]};
    // Out-of-order replies prove the bridge maps concurrent HTTP clients' repeated IDs correctly.
    setTimeout(()=>send({jsonrpc:'2.0',id:message.id,result}),handle === 'slow' ? 150 : 1);
  }
}
