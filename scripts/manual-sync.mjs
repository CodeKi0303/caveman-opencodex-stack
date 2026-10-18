import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runClient,ClientError} from './client-lib.mjs';

export async function manualSync(home,{run=runClient}={}) {
  home=path.resolve(home);
  let config;
  try {config=JSON.parse(fs.readFileSync(path.join(home,'caveman-client.json'),'utf8'));}
  catch {throw new ClientError('SETUP_REQUIRED','먼저 client.mjs configure 또는 reconfigure로 연결을 설정해 주세요.');}
  if(config.version!==1||typeof config.url!=='string'||typeof config.keyFile!=='string'||
      !path.isAbsolute(config.keyFile)||typeof config.codexHome!=='string'||path.resolve(config.codexHome)!==home)
    throw new ClientError('INVALID_SETTINGS','수동 동기화 설정이 올바르지 않습니다. 연결 설정을 다시 실행해 주세요.');
  const result=await run(['sync','--url',config.url,'--key-file',config.keyFile,'--codex-home',home]);
  const warning=Boolean(result.warnings?.length);
  return {...result,message:(result.catalogChanged?'모델 목록 갱신 완료.':'모델 목록에 변경이 없습니다.')+
    (result.restartCodex?' 새 목록을 사용하려면 Codex를 재시작해 주세요.':'')+
    (warning?' 연결 설정에 경고가 있습니다. doctor로 확인해 주세요.':'')};
}

export async function main(argv) {
  let home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),json=false;
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--json')json=true;
    else if(argv[i]==='--codex-home'&&argv[i+1])home=argv[++i];
    else throw new ClientError('USAGE','사용법: npm run sync -- [--codex-home 경로] [--json]');
  }
  try {const result=await manualSync(home);console.log(json?JSON.stringify(result):result.message);return 0;}
  catch(error) {
    const code=error instanceof ClientError?error.code:'SYNC_FAILED';
    const message=['SETUP_REQUIRED','INVALID_SETTINGS'].includes(code)?error.message:
      '동기화에 실패했습니다. 기존 목록은 유지됩니다. 서버 연결과 키 파일을 확인해 주세요. ('+code+')';
    console.log(json?JSON.stringify({ok:false,error:code,message}):message);return 1;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await main(process.argv.slice(2));}
  catch {console.error('사용법: npm run sync -- [--codex-home 경로] [--json]');process.exitCode=1;}
}
