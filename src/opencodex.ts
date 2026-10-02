import {existsSync,readFileSync} from 'node:fs';
import {getDefaultConfig,saveConfig} from '../node_modules/@bitkyc08/opencodex/src/config';
import {startServer} from '../node_modules/@bitkyc08/opencodex/src/server';
if (!existsSync(`${process.env.OPENCODEX_HOME}/config.json`)) {
  const config=getDefaultConfig();
  config.hostname='0.0.0.0';
  config.unauthenticatedLoopbackListener={enabled:true,port:10101};
  config.providers.openai.codexAccountMode='direct';
  config.providers.openai.authMode='forward';
  config.clientIntegrations={codex:false,claude:false,gemini:false};
  config.codexAutoStart=false;
  config.codexShimAutoRestore=false;
  config.websockets=false;
  saveConfig(config);
}
process.env.OPENCODEX_ADMIN_AUTH_TOKEN=readFileSync('/run/secrets/admin-key','utf8').trim();
process.env.OPENCODEX_API_AUTH_TOKEN=readFileSync('/run/secrets/gateway-key','utf8').trim();
const server=startServer(10100);
process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
