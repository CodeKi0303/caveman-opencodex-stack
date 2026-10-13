import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createManager,parseArgs,safeError,normalizeUrl,validatePort,readEnvironment,interactive,repository} from './manage-lib.mjs';

export const help=`Caveman + OpenCodex 올인원 설치 / 관리

  ./manage                         설치 및 관리 메뉴
  ./manage --setup                 설치 질문에 답한 뒤 종료
  ./manage --status                현재 연결 상태 확인 (설치하지 않음)
  ./manage --codex-home /경로       관리할 Codex 홈 지정
  ./manage --user | --system       서비스 범위 지정 (기본: 현재 사용자)

Linux/WSL에서 사용합니다. 서버 설치, 키 연결, Codex 로그인, 웹 제어와
자동 시작을 안내합니다. 이미 설치된 환경은 기존 경로·키·포트를 유지합니다.
GUI가 없어도 사용할 수 있습니다. 카탈로그 주기 작업은 등록하지 않습니다.
`;

export function terminalIO({input=process.stdin,output=process.stdout}={}) {
  const write=value=>output.write(String(value)+'\n');
  function ask(question,fallback='') {
    if(!input.isTTY||!output.isTTY)return Promise.reject(Error('TTY_REQUIRED'));
    return new Promise((resolve,reject)=>{
      const rl=readline.createInterface({input,output,terminal:true});let done=false;
      rl.on('SIGINT',()=>{if(!done){done=true;reject(Error('CANCELLED'));}rl.close();});
      rl.on('close',()=>{if(!done){done=true;reject(Error('CANCELLED'));}});
      rl.question(question+(fallback!==''?` [${fallback}]`:'')+': ',value=>{done=true;rl.close();resolve(value.trim()||fallback);});
    });
  }
  function secret(question) {
    if(!input.isTTY||!output.isTTY||!input.setRawMode)return Promise.reject(Error('TTY_REQUIRED'));
    return new Promise((resolve,reject)=>{
      let value='',done=false;const raw=input.isRaw,paused=input.isPaused();
      const finish=error=>{if(done)return;done=true;input.off('data',receive);input.off('error',failed);input.off('end',cancel);input.setRawMode(raw);if(paused)input.pause();output.write('\n');error?reject(error):resolve(value);};
      const failed=()=>finish(Error('INPUT_FAILED')),cancel=()=>finish(Error('CANCELLED'));
      function receive(chunk) {
        const text=chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z~]/g,'');
        for(const char of text) {
          if(['\x03','\x04','\x1b'].includes(char)){cancel();return;}
          if(char==='\r'||char==='\n'){finish();return;}
          if(char==='\x7f'||char==='\b'){if(value){value=value.slice(0,-1);output.write('\b \b');}continue;}
          if(char>=' '&&char<='~'){if(value.length>=4096){finish(Error('INVALID_GATEWAY_KEY'));return;}value+=char;output.write('*');}
        }
      }
      input.setRawMode(true);input.on('data',receive);input.once('error',failed);input.once('end',cancel);input.resume();output.write(question+': ');
    });
  }
  return {write,ask,secret,confirm:async(q,defaultYes=false)=>['y','yes','예'].includes((await ask(q+' (y/N)',defaultYes?'y':'n')).toLowerCase())};
}
const messages={
  TTY_REQUIRED:'대화형 터미널에서 ./manage를 실행하세요. 원격 명령은 ssh -t로 연결할 수 있습니다.',
  SCOPE_MISMATCH:'현재 OS 사용자와 설치된 서비스 범위가 다릅니다. 처음 설치한 사용자로 실행하세요. root는 --system을 사용합니다.',
  SYSTEMD_UNAVAILABLE:'systemd 서비스를 사용할 수 없습니다. WSL은 systemd를 활성화하고 배포판을 다시 시작한 뒤 실행하세요.',
  DEPENDENCIES_MISSING:'필수 프로그램의 설치 또는 버전 확인이 필요합니다.',
  PODMAN_REPOSITORY_TOO_OLD:'현재 OS 패키지 저장소는 Podman 4.9.3 이상을 제공하지 않습니다. 해당 버전이 지원되는 배포판/저장소를 먼저 준비해야 합니다. 임의의 외부 저장소를 추가하지 않았습니다.',
  PACKAGE_MANAGER_UNSUPPORTED:'이 배포판의 자동 패키지 설치를 지원하지 않습니다. 표시된 필수 프로그램을 설치한 뒤 다시 실행하세요.',
  INVALID_URL:'http:// 또는 https://로 시작하는 서버 주소를 입력하세요. /v1은 자동으로 맞춥니다.',
  INVALID_GATEWAY_KEY:'게이트웨이 키 형식이 올바르지 않습니다. 관리자 키나 ChatGPT 토큰이 아닌 게이트웨이 키를 사용하세요.',
  GATEWAY_KEY_REJECTED:'서버가 게이트웨이 키를 거부했습니다. 기존 설정은 유지했습니다.',
  GATEWAY_UNAVAILABLE:'서버에 연결하지 못했습니다. 주소·기동 상태·TLS 인증서를 확인하세요.',
  KEY_REQUIRED:'게이트웨이 키를 숨김 입력하거나 키 파일을 선택하세요.',
  KEY_FILE_UNREADABLE:'지정한 게이트웨이 키 파일을 읽지 못했습니다.',
  SERVER_UPGRADE_REQUIRED:'이 서버에는 웹 제어에 필요한 기능이 없습니다. 서버 프로젝트를 먼저 업데이트하세요.',
  PORT_IN_USE:'선택한 서버 포트를 다른 프로세스가 사용 중입니다. 다른 포트로 다시 설치하세요.',
  INVALID_PORT:'포트는 서로 다른 1024~65535 정수여야 합니다.',
  PORT_CHANGE_REQUIRES_REINSTALL:'기존 설치의 포트는 유지해야 합니다. 이번에는 기존 포트로 적용하세요.',
  MANAGER_BUSY:'같은 Codex 홈에서 다른 관리 작업이 실행 중입니다. 중단된 작업이면 caveman-stack/manager.lock의 PID를 확인하세요.',
  CONCURRENT_EDIT:'다른 프로그램이 동시에 설정을 바꿨습니다. 최신 설정으로 다시 실행하세요.',
  CONFIG_INVALID:'기존 설정 파일이 올바르지 않습니다. 자동으로 덮어쓰지 않았습니다.',
  LOCAL_SERVER_REQUIRED:'이 메뉴는 현재 Linux에 설치한 서버용입니다. 원격 서버에서는 SSH로 접속한 뒤 ./manage를 실행하세요.',
  SERVER_MANAGEMENT_REQUIRED:'서버 관리 연결이 없습니다. 서버에서 ./manage를 실행하거나 웹 제어의 SSH 관리 연결을 먼저 설정하세요.',
  NOT_CONFIGURED:'먼저 1번에서 설치 또는 연결 설정을 진행하세요.',
  BRIDGE_INSTALL_FAILED:'브리지 설치가 실패해 이전 연결 설정을 복구했습니다. 서비스·포트 소유권을 확인하세요.',
  CLIENT_INSTALL_FAILED:'브리지는 설치됐지만 Codex 설정 적용이 실패했습니다. 기존 Codex 설정을 확인한 뒤 9번으로 다시 적용하세요.',
  PANEL_INSTALL_FAILED:'브리지와 Codex 연결은 완료했지만 웹 설치가 실패했습니다. 9번으로 다시 적용하세요.',
  SERVER_OWNERSHIP_FAILED:'같은 이름의 서버 또는 서비스가 다른 저장소에 속해 있어 변경하지 않았습니다.',
  COMMAND_FAILED:'작업이 실패했습니다. 위 실행 결과와 서비스 상태를 확인한 뒤 다시 시도하세요.',
  CANCELLED:'취소했습니다. 이미 완료된 설치 단계는 유지됩니다.',
  INVALID_SELECTION:'표시된 메뉴 번호를 선택하세요.',
  USAGE:'지원하지 않는 옵션입니다. ./manage --help를 확인하세요.'
};
export function explainError(e){const code=safeError(e);return `${messages[code]??'작업을 완료하지 못했습니다. 설정과 서버 상태를 확인하세요.'} (${code})`;}
const expand=value=>path.resolve(value==='~'?os.homedir():value.startsWith('~/')?path.join(os.homedir(),value.slice(2)):value);

export function printAccess(io,manager,state) {
  io.write(`\n웹 제어: ${state.controlUrl}`);
  io.write(`관리 대상 Codex 홈: ${manager.codexHome}`);
  if(manager.isWsl)io.write('Windows 브라우저에서 위 주소를 여세요. WSL 배포판이 실행 중이어야 합니다. Windows 부팅 시 WSL 자체 자동 시작은 별도입니다.');
  else {
    const port=new URL(state.controlUrl).port;
    io.write(`원격 서버라면 사용자 PC에서: ssh -N -L 127.0.0.1:${port}:127.0.0.1:${port} USER@SERVER`);
    io.write('USER@SERVER는 이 Linux의 SSH 접속 계정과 주소입니다. 이 연결을 유지한 채 위 웹 주소를 여세요.');
  }
  io.write('관리 페이지는 이 Linux의 설정을 제어합니다. Windows/다른 사용자 설정은 각각 별도입니다.');
}
export function printStatus(io,state) {
  io.write(`\n설치: ${state.configured?'설정 있음':'아직 연결 없음'} · 서비스 범위: ${state.scope}`);
  if(state.configured){io.write(`서버: ${state.upstreamUrl}`);io.write(`브리지 ${state.bridge?.ok?'정상':'확인 필요'} · 서버 ${state.gateway?.ok?'정상':'확인 필요'} · 웹 ${state.web?'정상':'확인 필요'} · 모델 ${state.gateway?.models??'—'}개`);io.write(`Caveman: ${state.compression?'ON':'OFF'}`);}
}
export async function setup(io,manager) {
  io.write('\n1 이 Linux에 서버 + Codex 연결 + 웹 제어 설치\n2 기존 서버에 이 Linux의 Codex 연결 + 웹 제어 설치');
  const kind=await io.ask('설치 방식',manager.settings()?.management?.mode==='local'?'1':'2');
  if(!['1','2'].includes(kind))throw Error('INVALID_SELECTION');
  const full=kind==='1';
  const pre=await manager.requirements(full);
  if(!pre.systemd)throw Error('SYSTEMD_UNAVAILABLE');
  if(pre.missing.length){io.write('설치 또는 버전 갱신이 필요한 프로그램: '+pre.missing.join(', '));if(!await io.confirm('OS의 공식 패키지 관리자로 설치할까요?',true))throw Error('DEPENDENCIES_MISSING');const result=await manager.installDependencies(pre.missing);if(!result.ok)throw Error('DEPENDENCIES_MISSING');}
  let connection;
  if(full) {
    const oldEnv=readEnvironment(path.join(manager.repo,'.env'));
    let options={};
    if(oldEnv)io.write('기존 서버의 주소·포트·키·데이터를 유지합니다.');
    else {
      const share=await io.ask('모델 API 접근: 1 이 Linux만 / 2 다른 PC에서도 사용','1');
      if(!['1','2'].includes(share))throw Error('INVALID_SELECTION');
      options={bindAddress:share==='2'?'0.0.0.0':'127.0.0.1',port:validatePort(await io.ask('모델 API 포트','18787')),adminPort:validatePort(await io.ask('OpenCodex 관리자 포트','20100'))};
      io.write('관리자 화면은 이 Linux의 127.0.0.1에만 공개합니다. 서버 접속 키는 자동 생성합니다.');
    }
    options.latest=await io.confirm('기동 후 최신 안정 Caveman·OpenCodex·컨테이너 Codex까지 적용할까요?',true);
    if(manager.serviceScope()==='user'){
      options.linger=await io.confirm('로그아웃 후에도 사용자 서비스를 유지할까요? (관리자 인증 필요)',true);
      if(options.linger)await manager.authorizeLinger();
    }
    if(oldEnv&&!fs.existsSync(path.join(manager.repo,'data/stack-service-install.json')))options.adopt=await io.confirm('기존 수동 서비스가 있으면 같은 저장소의 서비스인지 검사 후 관리 대상으로 등록할까요?',true);
    if(!await io.confirm('위 구성으로 서버와 자동 시작 서비스를 설치할까요?',true))return {cancelled:true};
    io.write('서버 준비와 자동 시작 서비스를 적용합니다. 최초 이미지 빌드는 시간이 걸릴 수 있습니다…');
    const server=await manager.installServer(options);
    connection={upstreamUrl:server.tls?normalizeUrl(await io.ask('TLS 인증서에 맞는 서버 주소',server.upstreamUrl)):server.upstreamUrl,keyFile:server.keyFile,local:true};
  } else {
    const old=manager.settings();
    if(old?.management?.mode==='local')io.write('기존 서버 연결 방식에서 클라이언트 방식으로 전환합니다. 같은 Linux 서버 직접 관리 설정은 해제됩니다.');
    const upstreamUrl=normalizeUrl(await io.ask('연결할 서버 주소',old?.upstreamUrl??''));
    io.write('키 선택: 1 기존 키 유지 / 2 숨김 입력 / 3 키 파일 경로');
    const source=await io.ask('선택',old?'1':'2');
    if(!['1','2','3'].includes(source))throw Error('INVALID_SELECTION');
    connection={upstreamUrl,local:false};
    if(source==='2')connection.key=await io.secret('Gateway API 키');
    if(source==='3')connection.keyFile=expand(await io.ask('게이트웨이 키 파일 경로'));
    if(manager.serviceScope()==='user'&&await io.confirm('로그아웃 후에도 사용자 서비스를 유지할까요? (관리자 인증 필요)',false))await manager.enableClientLinger();
  }
  const defaults=await manager.defaults(),old=manager.settings();
  connection.compression=await io.confirm('Caveman 압축을 사용할까요?',old?.compression!==false);
  if(!old){connection.port=validatePort(await io.ask('Codex 연결 포트 (추천값 그대로 사용 가능)',String(defaults.port)));connection.controlPort=validatePort(await io.ask('웹 제어 포트 (추천값 그대로 사용 가능)',String(defaults.controlPort)));}
  io.write('접속 확인 → 브리지 설치 → Codex 연결 → 웹 제어 설치를 진행합니다…');
  const installed=await manager.configureConnection(connection);
  io.write('설치와 서비스 등록을 완료했습니다.');printAccess(io,manager,installed);
  if(await io.confirm('이 Linux의 Codex를 지금 디바이스 코드로 로그인할까요?',!fs.existsSync(path.join(manager.codexHome,'auth.json'))))await manager.login();
  const diagnosis=await manager.doctor();
  io.write(diagnosis.ok?'연결 진단 정상: 브리지 · 모델 목록 · 원문 복구 · 로그인':'연결 진단에서 확인할 항목: '+diagnosis.warnings.join(', '));
  io.write('실행 중인 Codex는 재시작하여 새 연결과 모델 목록을 적용하세요.');
  return {ok:true,diagnosis,controlUrl:installed.controlUrl};
}

export async function menu(io,manager,{setupOnly=false}={}) {
  io.write(`\nCaveman + OpenCodex 올인원\n현재 OS 사용자: ${manager.uid===0?'root':os.userInfo().username}\nCodex 홈: ${manager.codexHome}\n프로젝트: ${manager.repo}`);
  if(manager.uid===0)io.write('이 실행은 root의 Codex와 시스템 서비스를 관리합니다. 일반 사용자 Codex와는 별도입니다.');
  if(setupOnly)return setup(io,manager);
  for(;;) {
    io.write('\n1 설치 / 연결 설정\n2 상태 / 웹 주소\n3 Codex 로그인\n4 연결 진단\n5 모델 목록 수동 동기화\n6 Caveman 압축 ON/OFF\n7 서버 버전 확인\n8 이 서버 Git + 최신 버전 업데이트\n9 재시작 / 설치 다시 적용\n10 Codex 실행\n0 종료');
    const choice=await io.ask('선택',manager.settings()?'2':'1');
    try {
      if(choice==='0')return;
      if(choice==='1')await setup(io,manager);
      else if(choice==='2'){const s=await manager.status();printStatus(io,s);if(s.configured)printAccess(io,manager,s);}
      else if(choice==='3')await manager.login();
      else if(choice==='10')await manager.startCodex(expand(await io.ask('Codex에서 사용할 작업 폴더',process.cwd())));
      else if(choice==='4'){const d=await manager.doctor();io.write(d.ok?'연결 진단 정상':'확인 필요: '+d.warnings.join(', '));}
      else if(choice==='5'){const s=await manager.sync();io.write(s.catalogChanged?'모델 목록을 갱신했습니다. Codex를 재시작하세요.':'모델 목록에 변경이 없습니다.');}
      else if(choice==='6'){const enabled=await io.confirm('Caveman 압축을 사용할까요?',manager.settings()?.compression!==false);await manager.setCompression(enabled);io.write(`Caveman ${enabled?'ON':'OFF'}: 새 모델 요청부터 적용합니다.`);}
      else if(choice==='7'){const v=await manager.versions();for(const [name,item] of Object.entries(v.components))io.write(`${name}: 실행 중 ${item.current} / 최신 ${item.latest??'조회 실패'}`);}
      else if(choice==='8'){
        if(await io.confirm('Git 소스와 서버 패키지를 갱신합니다. 공유 클라이언트 연결이 잠시 끊길 수 있습니다. 실행할까요?')){
          await manager.updateGit();io.write('서버를 갱신했습니다. 새 설치 코드로 브리지와 웹 서비스를 다시 적용합니다…');
          await interactive('python3',[path.join(repository,'scripts/bootstrap.py'),'--repair','--codex-home',manager.codexHome,'--'+manager.serviceScope()]);return;
        }
      }
      else if(choice==='9'){
        const restartServer=manager.settings()?.management?.mode==='local'&&await io.confirm('Podman 서버도 재시작할까요?');
        if(restartServer)await manager.restartServer();await manager.installLocal();io.write('브리지와 웹 서비스를 다시 적용했습니다.');
      }
      else throw Error('INVALID_SELECTION');
    }catch(e){io.write(explainError(e));if(safeError(e)==='CANCELLED')return;}
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const opts=parseArgs(process.argv.slice(2));
    if(opts.help)console.log(help);
    else if(process.platform!=='linux')throw Error('UNSUPPORTED_PLATFORM');
    else {
      const manager=createManager(opts);manager.serviceScope();
      if(opts.status)console.log(JSON.stringify(await manager.status(),null,2));
      else if(opts.repair){await manager.installLocal();console.log('업데이트된 브리지와 웹 서비스를 적용했습니다.');printAccess(terminalIO(),manager,await manager.status());}
      else await menu(terminalIO(),manager,{setupOnly:opts.setup});
    }
  }catch(e){console.error(explainError(e));process.exitCode=1;}
}
