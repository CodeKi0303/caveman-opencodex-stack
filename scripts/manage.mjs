import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createManager,normalizeUrl,parseManagerArgs,safeError} from './manage-lib.mjs';

const help=`Caveman + OpenCodex 관리 터미널

  node scripts/manage.mjs [--codex-home DIR] [--user|--system]
  node scripts/manage.mjs --status [--codex-home DIR]

메뉴에서 Pod 주소 / Gateway API 키 설정, 설치, Caveman ON/OFF,
수동 카탈로그 동기화, 로컬·서버 재시작, 서버 Git/최신 버전 업데이트를 선택합니다.
--status는 설정과 연결 상태만 읽으며 키 값을 출력하지 않습니다.
Linux 기본값은 사용자 systemd 서비스이며 --system은 root가 실행해야 합니다.
기존 Linux 설치는 서비스 범위를 자동으로 유지합니다.
Gateway API 키는 모델 연결용이고 OpenCodex Admin Key와 별개입니다.
키는 숨김 입력 또는 기존 SSH 키로 한 번 가져와 로컬에 저장합니다.
주기적인 카탈로그 동기화 작업은 등록하지 않습니다.
`;

export function createTerminalIO({input=process.stdin,output=process.stdout}={}) {
  const write=value=>output.write(String(value)+'\n');
  const ask=(question,defaultValue='')=>{
    if(!input.isTTY||!output.isTTY)return Promise.reject(Error('TTY_REQUIRED'));
    return new Promise((resolve,reject)=>{
      const rl=readline.createInterface({input,output,terminal:true});let settled=false;
      const cancel=()=>{if(!settled){settled=true;reject(Error('CANCELLED'));}rl.close();};
      rl.on('SIGINT',cancel);rl.on('close',()=>{if(!settled){settled=true;reject(Error('CANCELLED'));}});
      rl.question(question+(defaultValue!==''?` [${defaultValue}]`:'')+': ',value=>{settled=true;rl.close();resolve(value.trim()||defaultValue);});
    });
  };
  const secret=question=>{
    if(!input.isTTY||!output.isTTY||typeof input.setRawMode!=='function')return Promise.reject(Error('TTY_REQUIRED'));
    return new Promise((resolve,reject)=>{
      let value='',finished=false;const wasRaw=input.isRaw,wasPaused=input.isPaused();
      const cleanup=()=>{input.off('data',receive);input.off('error',failed);input.off('end',cancel);input.setRawMode(wasRaw);if(wasPaused)input.pause();output.write('\n');};
      const finish=(error)=>{if(finished)return;finished=true;cleanup();if(error)reject(error);else resolve(value);};
      const failed=()=>finish(Error('INPUT_FAILED')),cancel=()=>finish(Error('CANCELLED'));
      const receive=chunk=>{
        // Ignore terminal escape sequences, including bracketed-paste markers.
        const text=chunk.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z~]/g,'');
        for(const char of text){
          if(char==='\x03'||char==='\x04'||char==='\x1b'){cancel();return;}
          if(char==='\r'||char==='\n'){finish();return;}
          if(char==='\x7f'||char==='\b'){if(value){value=value.slice(0,-1);output.write('\b \b');}continue;}
          if(char>=' '&&char<='~'){if(value.length>=4096){finish(Error('INVALID_GATEWAY_KEY'));return;}value+=char;output.write('*');}
        }
      };
      output.write(question+': ');input.setRawMode(true);input.on('data',receive);input.once('error',failed);input.once('end',cancel);input.resume();
    });
  };
  const confirm=async(question,defaultYes=false)=>{
    const answer=(await ask(question+' (y/N)',defaultYes?'y':'n')).toLowerCase();return ['y','yes','예'].includes(answer);
  };
  return {write,ask,secret,confirm};
}

const errors={
  TTY_REQUIRED:'대화형 터미널에서 실행하세요. 자동 점검에는 --status를 사용할 수 있습니다.',
  INVALID_URL:'Pod 주소는 http(s)://호스트:포트 또는 /v1 주소여야 합니다.',
  INVALID_GATEWAY_KEY:'Gateway API 키 형식이 올바르지 않습니다. 32~4096자의 공백 없는 키를 입력하세요.',
  GATEWAY_KEY_REJECTED:'서버가 Gateway API 키를 거부했습니다. Admin Key가 아닌 Gateway 키인지 확인하세요.',
  KEY_FILE_UNREADABLE:'저장한 Gateway 키 파일을 읽을 수 없습니다. 연결 설정에서 새 키를 입력하세요.',
  KEY_REQUIRED:'기존 키가 없습니다. 직접 입력하거나 SSH로 가져오세요.',
  KEY_PERMISSIONS_FAILED:'키 파일 접근 권한을 제한하지 못해 저장을 취소했습니다.',
  GATEWAY_UNAVAILABLE:'서버에 연결할 수 없습니다. 주소·서버 상태·인증서를 확인하세요.',
  INVALID_SERVER_RESPONSE:'서버 응답이 올바르지 않아 설정을 저장하지 않았습니다.',
  SERVER_UPGRADE_REQUIRED:'서버에 필요한 관리 기능이 없습니다. 서버 소스를 먼저 갱신하세요.',
  BRIDGE_UPGRADE_REQUIRED:'로컬 브릿지를 설치/다시 적용한 다음 설정을 변경하세요.',
  BRIDGE_INSTALLED_PANEL_FAILED:'브릿지와 Codex 연결은 적용됐지만 제어 페이지 설치가 실패했습니다. 로컬 설치를 다시 실행하세요.',
  BRIDGE_INSTALLED_CLIENT_FAILED:'브릿지는 설치됐지만 Codex 연결 적용에 실패했습니다. 이전 Codex 설정은 유지됩니다. 연결 진단 후 로컬 설치를 다시 실행하세요.',
  INVALID_SSH_SETTINGS:'SSH 호스트, 절대 키 파일 경로, 서버 프로젝트 경로를 확인하세요.',
  SSH_KEY_UNREADABLE:'SSH 키 파일을 읽을 수 없습니다. 해당 PC의 키 파일 경로를 지정하세요.',
  SSH_TARGET_MISMATCH:'SSH 호스트 이름과 Pod URL의 호스트 이름이 일치해야 합니다.',
  SSH_NOT_CONFIGURED:'먼저 SSH 관리 연결을 설정하세요.',
  SSH_UNAVAILABLE:'SSH를 실행할 수 없습니다. OpenSSH 설치와 PATH를 확인하세요.',
  SSH_TIMEOUT:'SSH 작업 시간이 초과됐습니다. 재실행 전에 서버 상태를 확인하세요.',
  SERVER_OPERATION_FAILED:'서버 작업이 실패했습니다. SSH 접속·호스트 신뢰·프로젝트 상태와 서버 작업 로그를 확인하세요.',
  LOCAL_COMMAND_FAILED:'로컬 설치 명령이 실패했습니다. 서비스 소유권·포트·Node.js·systemd 상태를 확인하세요.',
  SERVER_BUSY:'서버에서 다른 관리 작업이 실행 중입니다. 완료 후 다시 시도하세요.',
  GIT_DIRTY:'서버 Git 작업 폴더에 변경이 있어 갱신을 중단했습니다. 변경을 보존·정리한 후 다시 실행하세요.',
  NOT_CONFIGURED:'먼저 1번 메뉴에서 연결을 설정하세요.',
  CONFIG_INVALID:'저장된 브릿지 설정 형식이 올바르지 않습니다. 백업과 현재 파일을 점검하세요.',
  CONFIG_UNREADABLE:'로컬 브릿지 설정 파일을 읽을 수 없습니다.',
  INVALID_PORT:'브릿지와 제어 페이지 포트는 서로 다른 1024~65535 값이어야 합니다.',
  PORT_CHANGE_REQUIRES_REINSTALL:'현재 메뉴는 기존 설치의 포트를 유지합니다. 포트 이동은 별도 서비스 이전 절차가 필요합니다.',
  CONCURRENT_EDIT:'다른 관리 창에서 설정을 바꿨습니다. 최신 설정을 읽고 다시 시도하세요.',
  ROLLBACK_CONFLICT:'다른 설정 변경과 충돌해 자동 복원을 멈췄습니다. manager-backups와 현재 설정을 비교하세요.',
  UNSUPPORTED_PLATFORM:'현재 설치 기능은 Windows와 systemd 기반 Linux/WSL을 지원합니다.'
};
export function explainError(error){const code=safeError(error);return `${errors[code]??'작업이 실패했습니다. 설정과 서비스 상태를 확인하세요.'} (${code})`+
  (/^[a-f0-9]{32}$/.test(error?.jobId??'')?`\n서버 작업 로그: data/control-jobs/${error.jobId}.log`:'');}
const expand=value=>path.resolve(value==='~'?os.homedir():value.startsWith('~/')||value.startsWith('~\\')?path.join(os.homedir(),value.slice(2)):value);
const yesNo=value=>value?'정상':'확인 필요';

async function promptManagement(io,upstreamUrl,current) {
  io.write('SSH는 서버 재시작·업데이트와 키 가져오기에 사용합니다. 서버 SSH 공개키가 known_hosts에 먼저 등록되어 있어야 합니다.');
  const host=await io.ask('SSH 사용자@호스트',current?.host??'root@'+new URL(upstreamUrl).hostname);
  const keyFile=expand(await io.ask('이 PC에 저장된 SSH 개인키 파일 경로',current?.keyFile??path.join(os.homedir(),'.ssh','id_ed25519')));
  const repo=await io.ask('서버의 프로젝트 절대 경로',current?.repo??'/home/caveman-podman');
  return {host,keyFile,repo};
}

async function setup(io,manager) {
  const old=manager.settings();
  io.write('\n모델 연결에는 Gateway API 키를 사용합니다. OpenCodex Admin Key나 ChatGPT 로그인 토큰을 입력하지 마세요.');
  const upstreamUrl=normalizeUrl(await io.ask('Pod API 주소',old?.upstreamUrl??''));
  io.write('키 선택: 1 기존 키 유지 / 2 숨김 입력 / 3 SSH로 한 번 가져오기');
  const source=await io.ask('선택',old?'1':'2');
  if(!['1','2','3'].includes(source))throw Error('INVALID_SELECTION');
  let management=old?.management??null,key;
  if(source==='3')management=await promptManagement(io,upstreamUrl,management);
  else {
    if(source==='2')key=await io.secret('Gateway API 키 (입력 내용은 표시되지 않습니다)');
    const mismatch=management&&management.host.split('@').at(-1).toLowerCase()!==new URL(upstreamUrl).hostname.toLowerCase();
    if(mismatch){io.write('서버 주소가 바뀌어 기존 SSH 연결은 해제합니다.');management=null;}
    if(await io.confirm('서버 관리용 SSH 연결을 지금 설정/변경할까요?'))management=await promptManagement(io,upstreamUrl,management);
  }
  const compression=await io.confirm('이 클라이언트에서 Caveman 압축을 사용할까요?',old?.compression!==false);
  const port=old?.port??Number(await io.ask('로컬 브릿지 포트',String(manager.defaults.port)));
  const controlPort=old?(old.controlPort??18786):Number(await io.ask('로컬 제어 페이지 포트',String(manager.defaults.controlPort)));
  io.write('서버 키와 모델 목록을 검증하고 설정을 저장합니다…');
  const result=await manager.saveConnection({upstreamUrl,key,management,importKey:source==='3',compression,port,controlPort});
  io.write(`연결 저장 완료 · 모델 ${result.models}개 · 키는 로컬 보호 파일에 저장했습니다.`);
  if(result.appliedToClient)io.write('실행 중인 브릿지에 적용했습니다. Codex를 다시 시작하면 MCP 연결 설정도 반영됩니다.');
  if(await io.confirm(result.installRequired?'브릿지와 제어 페이지를 설치하고 Codex에 적용할까요?':'브릿지와 제어 페이지 설치를 다시 적용할까요?',result.installRequired))await install(io,manager);
}

async function install(io,manager){
  io.write('브릿지·Codex 연결·제어 페이지를 적용합니다. 서비스 점검까지 잠시 기다리세요…');
  const result=await manager.installLocal();io.write(`적용 완료 · 제어 페이지: ${result.controlUrl}`);
  io.write('Codex를 다시 시작하면 새 연결 설정이 반영됩니다. 각 PC의 ChatGPT 로그인은 그대로 유지합니다.');
}

async function showStatus(io,manager) {
  const status=await manager.status();
  if(!status.configured){io.write('아직 연결이 없습니다. 1번 메뉴에서 시작하세요.');return;}
  io.write(`Pod: ${status.settings.upstreamUrl}\nGateway 키: ${status.settings.keyConfigured?'저장됨':'없음'}\nCaveman: ${status.settings.compression?'ON':'OFF'}\n로컬 브릿지: ${yesNo(status.bridge.ok)}\n서버 연결: ${yesNo(status.gateway.ok)}\n제어 페이지: ${status.controlUrl}\nSSH 관리: ${status.settings.management?.host??'미설정'}\n설정 위치: ${status.codexHome}`);
  if(status.gateway.error)io.write(explainError({message:status.gateway.error}));
}

async function remoteAction(io,manager,action) {
  const labels={'status':'서버 상태 확인','check':'업데이트 확인','restart':'서버 재시작','git-update':'서버 Git 소스 + 최신 안정 버전 업데이트','latest-update':'현재 서버 소스로 최신 안정 버전 업데이트','catalog':'서버 카탈로그 갱신'};
  if(['restart','git-update','latest-update','catalog'].includes(action)){
    io.write(`대상: ${manager.settings()?.management?.host??'SSH 미설정'} · ${manager.settings()?.management?.repo??''}`);
    if(action==='restart'||action.includes('update'))io.write('같은 서버를 사용하는 모든 클라이언트에 영향을 줍니다. 업데이트 중에는 이 터미널을 닫지 마세요.');
    if(action==='git-update')io.write('서버의 현재 Git 브랜치를 갱신합니다. 미커밋 변경이 있으면 중단합니다.');
    if(!await io.confirm(labels[action]+'를 진행할까요?'))return;
  }
  io.write(labels[action]+' 중…');
  const timer=setInterval(()=>io.write('서버 작업이 계속 진행 중입니다. 터미널을 열어 두세요.'),30000);timer.unref?.();
  try {
    const result=await manager.remoteOperation(action);
    if(action==='status'){
      io.write(`컨테이너: ${result.exists?'있음':'없음'} · 실행: ${result.running?'중':'안 됨'} · 상태: ${String(result.status??'unknown').replace(/[^a-zA-Z0-9 _-]/g,'')} · Health: ${String(result.health??'unknown').replace(/[^a-zA-Z0-9 _-]/g,'')}\n서버 Git 변경: ${result.gitDirty===null?'확인 불가':result.gitDirty?'있음':'없음'}`);
    }else if(action==='check'){
      for(const name of ['caveman','opencodex']){const c=result.components?.[name];const version=v=>/^\d+\.\d+\.\d+([.+-][a-zA-Z0-9.-]+)?$/.test(v??'')?v:'확인 불가';io.write(`${name}: 현재 ${version(c?.current)} / 최신 ${version(c?.latest)}`);}
    }else{
      io.write('서버 작업이 완료됐습니다.');
      if(typeof result.jobId==='string'&&/^[a-zA-Z0-9-]+$/.test(result.jobId))io.write('작업 ID: '+result.jobId);
      if(action.includes('update')||action==='catalog')io.write('이 PC에 새 모델 목록을 반영하려면 5번 수동 동기화를 실행하세요.');
    }
  }finally{clearInterval(timer);}
}

export async function runManagerMenu(manager,io) {
  io.write('Caveman + OpenCodex 올인원 관리\n설정과 키는 이 PC에 저장하며 다른 PC의 설정과 자동 동기화하지 않습니다.');
  for(;;){
    io.write('\n1 연결 설정 / API 키 지정\n2 로컬 브릿지·제어 페이지 설치/적용\n3 현재 연결 상태\n4 Caveman ON/OFF\n5 모델 카탈로그 수동 동기화\n6 연결 진단\n7 로컬 재시작 / Codex 연결 재적용\n8 서버 상태\n9 서버 재시작\n10 서버 Git + 최신 버전 업데이트\n11 서버 최신 버전 업데이트 (Git 유지)\n12 SSH 관리 연결 설정\n13 서버 업데이트 확인\n0 종료');
    let choice;try{choice=await io.ask('선택','0');}catch(error){if(safeError(error)==='CANCELLED')return;throw error;}
    if(choice==='0')return;
    try {
      if(choice==='1')await setup(io,manager);
      else if(choice==='2'){if(await io.confirm('로컬 서비스를 설치/다시 적용하고 Codex 연결을 변경할까요?'))await install(io,manager);}
      else if(choice==='3')await showStatus(io,manager);
      else if(choice==='4'){
        const c=manager.settings();if(!c)throw Error('NOT_CONFIGURED');
        const value=await io.ask('Caveman 1 ON / 2 OFF',c.compression!==false?'1':'2');if(!['1','2'].includes(value))throw Error('INVALID_SELECTION');
        const result=await manager.setCompression(value==='1');io.write(`Caveman ${result.compression?'ON':'OFF'} 저장 완료. ${result.applied?'다음 요청부터 적용됩니다.':'로컬 설치/재시작 후 적용됩니다.'}`);
      }else if(choice==='5'){
        io.write('모델 목록을 수동 동기화합니다…');const result=await manager.sync();io.write(result.catalogChanged?'모델 목록을 갱신했습니다. Codex를 다시 시작하세요.':'모델 목록 변경이 없습니다.');
        if(result.warnings?.length)io.write('연결 설정 확인이 필요합니다. 6번 연결 진단을 실행하세요.');
      }else if(choice==='6'){
        io.write('연결을 진단합니다…');const result=await manager.doctor();io.write(`진단: ${yesNo(result.ok)} · 카탈로그 ${yesNo(result.catalog?.ok)} · 복구 MCP ${yesNo(result.mcp?.ok)} · 브릿지 ${yesNo(result.bridge?.ok)}`);
        if(result.warnings?.length)io.write('주의 항목: '+result.warnings.filter(v=>typeof v==='string'&&/^[a-z_]+$/.test(v)).join(', '));
      }else if(choice==='7'){
        if(await io.confirm('로컬 서비스를 다시 적용하고 Codex를 브릿지에 연결한 뒤 재시작할까요? 진행 중인 요청이 끊길 수 있습니다.')){await manager.restartLocal();io.write('로컬 서비스 재시작 완료. Codex를 다시 시작하면 연결 설정이 반영됩니다.');}
      }else if(['8','9','10','11','13'].includes(choice))await remoteAction(io,manager,{'8':'status','9':'restart','10':'git-update','11':'latest-update','13':'check'}[choice]);
      else if(choice==='12'){
        const c=manager.settings();if(!c)throw Error('NOT_CONFIGURED');
        await manager.saveManagement(await promptManagement(io,c.upstreamUrl,c.management));io.write('SSH 연결을 확인하고 저장했습니다.');
      }else io.write('메뉴 번호를 선택하세요.');
    }catch(error){if(safeError(error)==='CANCELLED')io.write('현재 입력을 취소했습니다.');else io.write(explainError(error));}
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const opts=parseManagerArgs(process.argv.slice(2));
    if(opts.help)console.log(help);
    else {
      const manager=createManager(opts);
      if(opts.status)console.log(JSON.stringify(await manager.status(),null,2));
      else await runManagerMenu(manager,createTerminalIO());
    }
  }catch(error){console.error(safeError(error)==='USAGE'?help:explainError(error));process.exitCode=1;}
}
