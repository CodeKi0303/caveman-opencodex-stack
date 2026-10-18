const $=id=>document.getElementById(id),token=document.querySelector('meta[name="control-token"]').content;
const idleDelay=10000,busyDelay=2500;
const components={caveman:'Caveman CLI',opencodex:'OpenCodex',codex:'Codex CLI (서버 Pod)'};
let timer,inFlight,lastJob,versions={},localManagement=null;
let statusAvailable=false,settingsSaving=false,noticeSource=null;
let settingsDirty=false,settingsRevision=0,lastCheckedAt=null,lastStatus=null;
const versionDirty=new Set();
const errors={GATEWAY_KEY_REJECTED:'서버가 인증키를 거부했습니다.',GATEWAY_UNAVAILABLE:'서버에 연결할 수 없습니다.',INVALID_URL:'API 주소는 http(s)://호스트:포트/v1 형식이어야 합니다.',INVALID_KEY:'인증키는 줄바꿈 없이 32자 이상이어야 합니다.',SERVER_UPGRADE_REQUIRED:'서버 게이트웨이를 먼저 업데이트해야 이 기능을 사용할 수 있습니다.',BRIDGE_UPGRADE_REQUIRED:'로컬 브리지를 먼저 업데이트해 주세요.',SSH_NOT_CONFIGURED:'서버 업데이트용 SSH 연결을 먼저 저장하세요.',SSH_TARGET_MISMATCH:'SSH 대상과 Pod 주소의 호스트가 다릅니다. 연결 설정을 확인하세요.',SSH_UNAVAILABLE:'SSH를 실행할 수 없습니다.',SERVER_OPERATION_FAILED:'서버 작업이 실패했습니다. 서버 상태와 비공개 작업 로그를 확인하세요.',SERVER_BUSY:'다른 서버 작업이 실행 중입니다.',OPERATION_BUSY:'현재 작업이 끝난 후 다시 시도하세요.',INVALID_VERSION:'버전은 숫자.숫자.숫자 형식으로 입력하세요.',INSUFFICIENT_DISK:'서버에 최소 4 GiB 여유 공간이 필요합니다.',INVALID_SSH_SETTINGS:'SSH 대상·개인키 경로·서버 디렉터리를 확인하세요.',SSH_KEY_UNREADABLE:'SSH 개인키 파일을 읽을 수 없습니다.',DOCTOR_FAILED:'연결 진단에서 문제가 발견됐습니다. 결과를 확인하세요.',CONTROL_TOKEN_REQUIRED:'관리 페이지가 다시 시작되었습니다. 브라우저를 새로고침해 주세요.'};
const message=e=>errors[e]??('작업을 완료하지 못했습니다.'+(/^[A-Z_]+$/.test(e??'')?' ('+e+')':''));
Object.assign(errors,{INVALID_LOCAL_MANAGEMENT:'Linux 직접 관리 설정이 현재 프로젝트와 일치하지 않습니다.',LOCAL_MANAGEMENT_LOCKED:'직접 관리 모드의 Pod 주소와 프로젝트 경로는 서버 설치 설정으로 유지됩니다.',LOCAL_MANAGEMENT_UNAVAILABLE:'서버의 Python 관리 작업을 시작할 수 없습니다.',LOCAL_MANAGEMENT_TIMEOUT:'서버 작업 대기 시간이 초과됐습니다. 다시 실행하기 전에 서버 상태를 확인하세요.'});
function setText(element,text){if(element.textContent!==text)element.textContent=text;}
function hideNotice(){$('notice').hidden=true;noticeSource=null;}
function notice(text,error=false,source='action'){
 noticeSource=source;
 $('notice').hidden=false;$('notice-text').textContent=text;$('notice').className='notice'+(error?' error':'');
}
async function api(route,body){
 const r=await fetch('/api/'+route,{method:body===undefined?'GET':'POST',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(route==='status'?{signal:AbortSignal.timeout(30000)}:{})});
 const data=await r.json();if(!r.ok)throw Error(data.error||'OPERATION_FAILED');return data;
}
function showRoute(){const on=$('compression').checked;$('route-compression').textContent=on?'Caveman':'압축 건너뛰기';$('compression-text').textContent=on?'새 모델 요청에 압축을 적용합니다.':'OpenCodex로 직접 전달합니다.';}
function renderResult(job){
 const labels={sync:'모델 카탈로그 동기화',doctor:'연결 진단','check-update':'서버 버전 확인',update:'서버 업데이트','refresh-server-catalog':'서버 카탈로그 갱신'};
 $('job-badge').textContent=job.status==='running'?'실행 중':job.status==='succeeded'?'완료':'실패';$('job-title').textContent=labels[job.action]??job.action;
 if(job.status==='running'){setText($('job-result'),job.action==='update'?'버전 준비 → 이미지 빌드 → 후보 검사 → 백업 및 적용\n몇 분이 걸릴 수 있습니다.':'연결을 확인하고 있습니다…');return;}
 const r=job.result;
 if(r?.components){versions=r.components;for(const c of Object.keys(components)){const v=versions[c];if(!v)continue;$(c+'-current').textContent=v.current??'—';$(c+'-latest').textContent=v.latest??'확인 실패';if(!versionDirty.has(c))$(c+'-version').value=v.latest??v.current??'';}}
 let text=job.error?message(job.error):r?.message??(job.action==='sync'?(r.changed?'모델 목록을 갱신했습니다.':'모델 목록에 변경이 없습니다.'):(job.action==='doctor'?'연결 진단을 완료했습니다.':'버전을 확인했습니다.'));
 if(r?.restartCodex)text+='\n새 목록을 사용하려면 Codex를 재시작하세요.';
 if(r?.warnings?.length)text+='\n설정 경고: '+r.warnings.join(', ');
 if(job.action==='doctor'&&r)text+='\n브리지: '+(r.bridge?.ok?'정상':'확인 필요')+' · 카탈로그: '+(r.catalog?.ok?'정상':'확인 필요')+' · 원문 복구: '+(r.mcp?.ok?'정상':'확인 필요');
 if(r?.jobId)text+='\n서버 작업 ID: '+r.jobId;
 setText($('job-result'),text);
 const marker=job.id+':'+job.status;
 if(job.status==='failed'&&lastJob!==marker)notice(text,true,'job');
 if(job.status==='succeeded'&&noticeSource==='job')hideNotice();lastJob=marker;
}
function renderHealth(alerts){
 const current=Array.isArray(alerts)?alerts.filter(a=>a&&typeof a.message==='string'):[];
 $('health-alerts').hidden=current.length===0;
 $('health-alerts').className='notice'+(current.some(a=>a.severity==='error')?' error':' warning');
 setText($('health-alert-text'),current.map(a=>a.message).join('\n'));
}
function checkedText(stale=false){
 $('status-updated').textContent=lastCheckedAt?(stale?'상태 갱신 실패 · 마지막 확인 ':'마지막 상태 확인 ')+new Date(lastCheckedAt).toLocaleString('ko-KR'):'아직 상태를 확인하지 못했습니다.';
 $('status-updated').className='hint'+(stale?' stale':'');
}
function renderStatus(s,requestedRevision){
 lastStatus=s;
 const checked=new Date(s.checkedAt??Date.now());lastCheckedAt=Number.isNaN(checked.getTime())?new Date().toISOString():checked.toISOString();checkedText();
 $('bridge-status').textContent=s.bridge.ok?'● 정상 연결':'○ 연결 확인 필요';
 $('gateway-status').textContent=s.gateway.ok?'● 인증 확인됨':'○ 연결 또는 버전 확인';
 $('authentication-status').textContent=s.authentication?.mode==='pool'?'서버 계정 풀':s.authentication?.mode==='direct'?'요청별 계정 선택 (direct)':'서버 설정 확인 필요';
 $('catalog-status').textContent='선택 가능 '+s.catalog.count+'개';$('model-count').textContent=s.catalog.count;
 const catalogDetails=Number.isInteger(s.catalog.totalCount)&&Number.isInteger(s.catalog.hiddenCount);
 $('catalog-summary').hidden=!catalogDetails;
 $('catalog-summary').textContent=catalogDetails?'전체 '+s.catalog.totalCount+'개 · 숨김 '+s.catalog.hiddenCount+'개':'';
 $('catalog-date').textContent='마지막 로컬 변경 '+(s.catalog.modified?new Date(s.catalog.modified).toLocaleString('ko-KR'):'—');
 renderHealth(s.alerts??[...(!s.bridge.ok?[{severity:'warning',message:'로컬 브리지 연결을 확인해 주세요.'}]:[]),...(!s.gateway.ok?[{severity:'error',message:'서버 연결 또는 인증 상태를 확인해 주세요.'}]:[])]);
 localManagement=s.settings.management?.mode==='local'?{mode:'local',repo:s.settings.management.repo}:null;
 $('ssh-settings').hidden=!!localManagement;$('local-management').hidden=!localManagement;$('upstream').readOnly=!!localManagement;
 if(!settingsDirty&&requestedRevision===settingsRevision){
  $('upstream').value=s.settings.upstreamUrl;$('compression').checked=s.settings.compression;
  $('ssh-host').value=s.settings.management?.host??'';$('ssh-key').value=s.settings.management?.keyFile??'';$('ssh-repo').value=s.settings.management?.repo??'';showRoute();
 }
 statusAvailable=true;
 document.querySelectorAll('[data-mutating]').forEach(b=>b.disabled=s.busy||settingsSaving);
 if(s.job)renderResult(s.job);
}
function schedule(){
 clearTimeout(timer);
 if(!document.hidden)timer=setTimeout(refresh,lastStatus?.busy?busyDelay:idleDelay);
}
function refresh(){
 clearTimeout(timer);
 if(inFlight)return inFlight;
 const requestedRevision=settingsRevision;
 inFlight=(async()=>{
  try{renderStatus(await api('status'),requestedRevision);}
  catch(e){
   statusAvailable=false;
   $('bridge-status').textContent='○ 상태 확인 안 됨';$('gateway-status').textContent='○ 상태 확인 안 됨';$('authentication-status').textContent='서버 설정 확인 필요';
   renderHealth([{severity:'error',message:e.message==='CONTROL_TOKEN_REQUIRED'?message(e.message):'상태를 갱신하지 못했습니다. 자동으로 다시 확인합니다.'}]);checkedText(true);
   document.querySelectorAll('[data-mutating]').forEach(b=>b.disabled=true);
  }finally{inFlight=null;schedule();}
 })();
 return inFlight;
}
async function refreshAfterAction(){if(inFlight)await inFlight;return refresh();}
async function job(action,body={}){try{await api(action,body);await refreshAfterAction();}catch(e){notice(message(e.message),true,'job');}}
$('compression').addEventListener('change',showRoute);$('refresh').addEventListener('click',refresh);
$('dismiss-notice').addEventListener('click',hideNotice);
for(const event of ['input','change'])$('settings-form').addEventListener(event,()=>{settingsDirty=true;settingsRevision++;});
$('settings-form').addEventListener('submit',async e=>{
 e.preventDefault();const host=$('ssh-host').value.trim(),management=localManagement??(host?{host,keyFile:$('ssh-key').value.trim(),repo:$('ssh-repo').value.trim()}:null);
 const button=e.submitter,revision=settingsRevision,key=$('gateway-key').value;if(button)button.disabled=true;settingsSaving=true;
 try{
  const r=await api('settings',{upstreamUrl:$('upstream').value.trim(),key,compression:$('compression').checked,management});
  if($('gateway-key').value===key)$('gateway-key').value='';if(settingsRevision===revision){settingsDirty=false;settingsRevision++;}
  notice(r.message);await refreshAfterAction();
 }catch(error){notice(message(error.message),true);}
 finally{settingsSaving=false;document.querySelectorAll('[data-mutating]').forEach(b=>b.disabled=lastStatus?.busy===true||!statusAvailable);}
});
for(const [id,action] of [['sync','sync'],['doctor','doctor'],['check-update','check-update'],['server-catalog','refresh-server-catalog']])$(id).addEventListener('click',()=>job(action));
for(const component of Object.keys(components))$(component+'-version').addEventListener('input',()=>{versionDirty.add(component);});
let update;
document.querySelectorAll('[data-update]').forEach(button=>button.addEventListener('click',()=>{
 const component=button.dataset.update,version=$(component+'-version').value.trim();if(!/^\d+\.\d+\.\d+$/.test(version)){notice(message('INVALID_VERSION'),true);return;}
 update={component,version};$('confirm-detail').textContent=components[component]+' '+(versions[component]?.current??'현재 버전')+' → '+version;$('confirm').showModal();
}));
$('confirm').addEventListener('close',()=>{if($('confirm').returnValue==='apply'&&update)job('update',{...update,confirm:true});update=null;});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else refresh();});
window.addEventListener('focus',()=>{if(!document.hidden)refresh();});
refresh();
