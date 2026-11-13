const $=id=>document.getElementById(id),token=document.querySelector('meta[name="control-token"]').content;
const idleDelay=10000,busyDelay=2500;
const components={caveman:'Caveman CLI',opencodex:'OpenCodex',codex:'Codex CLI (서버 Pod)'};
let timer,inFlight,lastJob,versions={},localManagement=null;
let statusAvailable=false,settingsSaving=false,noticeSource=null;
let settingsDirty=false,settingsRevision=0,lastCheckedAt=null,lastStatus=null;
let registrySaving=false,remoteFormRevision=0,remoteSignature='',remoteTargets=[],remotePending=null;
const remoteSelected=new Set(),remoteRows=new Map();
const versionDirty=new Set();
const selectedUpdates=()=>Object.keys(components).filter(c=>$(c+'-selected').checked);
function selectionChanged(){setText($('update-selection-count'),selectedUpdates().length+'개 선택');}
const errors={GATEWAY_KEY_REJECTED:'서버가 인증키를 거부했습니다.',GATEWAY_UNAVAILABLE:'서버에 연결할 수 없습니다.',INVALID_URL:'API 주소는 http(s)://호스트:포트/v1 형식이어야 합니다.',INVALID_KEY:'인증키는 줄바꿈 없이 32자 이상이어야 합니다.',SERVER_UPGRADE_REQUIRED:'서버 게이트웨이를 먼저 업데이트해야 이 기능을 사용할 수 있습니다.',BRIDGE_UPGRADE_REQUIRED:'로컬 브리지를 먼저 업데이트해 주세요.',SSH_NOT_CONFIGURED:'서버 업데이트용 SSH 연결을 먼저 저장하세요.',SSH_TARGET_MISMATCH:'SSH 대상과 Pod 주소의 호스트가 다릅니다. 연결 설정을 확인하세요.',SSH_UNAVAILABLE:'SSH를 실행할 수 없습니다.',SERVER_OPERATION_FAILED:'서버 작업이 실패했습니다. 서버 상태와 비공개 작업 로그를 확인하세요.',SERVER_BUSY:'다른 서버 작업이 실행 중입니다.',OPERATION_BUSY:'현재 작업이 끝난 후 다시 시도하세요.',INVALID_VERSION:'버전은 숫자.숫자.숫자 형식으로 입력하세요.',INSUFFICIENT_DISK:'서버에 최소 4 GiB 여유 공간이 필요합니다.',INVALID_SSH_SETTINGS:'SSH 대상·개인키 경로·서버 디렉터리를 확인하세요.',SSH_KEY_UNREADABLE:'SSH 개인키 파일을 읽을 수 없습니다.',DOCTOR_FAILED:'연결 진단에서 문제가 발견됐습니다. 결과를 확인하세요.',CONTROL_TOKEN_REQUIRED:'관리 페이지가 다시 시작되었습니다. 브라우저를 새로고침해 주세요.'};
const message=e=>errors[e]??('작업을 완료하지 못했습니다.'+(/^[A-Z_]+$/.test(e??'')?' ('+e+')':''));
Object.assign(errors,{INVALID_LOCAL_MANAGEMENT:'Linux 직접 관리 설정이 현재 프로젝트와 일치하지 않습니다.',LOCAL_MANAGEMENT_LOCKED:'직접 관리 모드의 Pod 주소와 프로젝트 경로는 서버 설치 설정으로 유지됩니다.',LOCAL_MANAGEMENT_UNAVAILABLE:'서버의 Python 관리 작업을 시작할 수 없습니다.',LOCAL_MANAGEMENT_TIMEOUT:'서버 작업 대기 시간이 초과됐습니다. 다시 실행하기 전에 서버 상태를 확인하세요.'});
errors.INVALID_UPDATE_SELECTION='업데이트할 항목을 1개 이상 선택하세요. 같은 항목을 중복으로 지정할 수 없습니다.';
errors.SSH_TIMEOUT='응답 대기 시간이 지났습니다. 서버 작업은 계속될 수 있으니 서버의 작업 기록과 실행 버전을 확인하세요.';
errors.LOCAL_MANAGEMENT_TIMEOUT=errors.SSH_TIMEOUT;
Object.assign(errors,{INVALID_CLIENT_AUTH_MODE:'서버 계정 사용 또는 각 PC의 로그인 전달을 선택하세요.',INVALID_REMOTE_SELECTION:'작업할 PC를 1대 이상 선택하세요.',REMOTE_CLIENTS_PARTIAL_FAILURE:'일부 PC의 작업이 실패했습니다. 아래 PC별 결과를 확인하세요.',REMOTE_CONTROL_UPGRADE_REQUIRED:'대상 PC의 프로젝트와 제어 페이지를 먼저 업데이트하세요.',REMOTE_CONTROL_UNAVAILABLE:'대상 PC의 로컬 제어 페이지가 실행 중인지 확인하세요.',REMOTE_CONTROL_CONFIG_MISMATCH:'입력한 설정 경로와 대상 PC의 실행 중인 제어 페이지가 다릅니다.',REMOTE_SSH_FAILED:'SSH 계정·키·호스트 신뢰·포트를 확인하세요.',REMOTE_SSH_UNAVAILABLE:'이 PC에서 SSH를 실행할 수 없습니다.',REMOTE_SSH_TIMEOUT:'SSH 작업 시간이 초과됐습니다. 대상 PC 상태를 확인하세요.',REMOTE_BOOTSTRAP_FAILED:'대상 설정 경로와 Python/PowerShell·Node 설치를 확인하세요.',INVALID_REMOTE_HOST:'SSH 대상은 user@host 또는 SSH 호스트 별칭으로 입력하세요.',INVALID_REMOTE_CONFIG:'대상 PC의 config.toml 또는 native-bridge.json 절대 경로를 입력하세요.',INVALID_REMOTE_PORT:'SSH 포트는 1부터 65535까지 입력하세요.',INVALID_REMOTE_SSH_KEY:'이 PC의 SSH 개인키 절대 경로를 입력하거나 비워 두세요.',INVALID_REMOTE_NODE_PATH:'대상 PC의 Node 실행 파일 절대 경로를 입력하거나 비워 두세요.',INVALID_REMOTE_LABEL:'PC 표시 이름은 100자 이내로 입력하세요.',DUPLICATE_REMOTE_TARGET:'같은 PC와 설정 경로가 이미 등록되어 있습니다.',REMOTE_SETTINGS_UNSAVED:'먼저 이 PC의 연결 설정을 저장한 다음 다른 PC에 적용하세요.'});
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
 const labels={sync:'모델 카탈로그 동기화',doctor:'연결 진단','check-update':'서버 버전 확인',update:'서버 업데이트','refresh-server-catalog':'서버 카탈로그 갱신','remote-client-action':'등록된 PC 관리'};
 $('job-badge').textContent=job.status==='running'?'실행 중':job.status==='succeeded'?'완료':'실패';$('job-title').textContent=labels[job.action]??job.action;
 if(job.status==='running'){setText($('job-result'),job.action==='update'?'버전 준비 → 이미지 빌드 → 후보 검사 → 백업 및 적용\n몇 분이 걸릴 수 있습니다.':'연결을 확인하고 있습니다…');return;}
 const r=job.result;
 if(r?.components){versions=r.components;for(const c of Object.keys(components)){const v=versions[c];if(!v)continue;$(c+'-current').textContent=v.current??'—';$(c+'-latest').textContent=v.latest??'확인 실패';if(!versionDirty.has(c))$(c+'-version').value=v.latest??v.current??'';}}
 if(job.action==='update'&&job.status==='succeeded'&&Array.isArray(r?.updates)){for(const {component,version} of r.updates){if(!components[component])continue;versions[component]={...versions[component],current:version};setText($(component+'-current'),version);}}
 let text=job.error?message(job.error):r?.message??(job.action==='sync'?(r.changed?'모델 목록을 갱신했습니다.':'모델 목록에 변경이 없습니다.'):(job.action==='doctor'?'연결 진단을 완료했습니다.':'버전을 확인했습니다.'));
 if(r?.restartCodex)text+='\n새 목록을 사용하려면 Codex를 재시작하세요.';
 if(r?.warnings?.length)text+='\n설정 경고: '+r.warnings.join(', ');
 if(job.action==='doctor'&&r)text+='\n브리지: '+(r.bridge?.ok?'정상':'확인 필요')+' · 카탈로그: '+(r.catalog?.ok?'정상':'확인 필요')+' · 원문 복구: '+(r.mcp?.ok?'정상':'확인 필요');
 if(r?.jobId)text+='\n서버 작업 ID: '+r.jobId;
 if(Array.isArray(r?.results))text=remoteResultsText(r);
 setText($('job-result'),text);
 const marker=job.id+':'+job.status;
 if(job.status==='failed'&&lastJob!==marker)notice(text,true,'job');
 if(job.status==='succeeded'&&noticeSource==='job')hideNotice();lastJob=marker;
}
function remoteResultsText(report){
 const results=report.results,failed=results.filter(item=>!item.ok).length;
 const lines=['완료 '+(results.length-failed)+'대 · 실패 '+failed+'대'];
 for(const item of results){
  const result=item.result??{},name=item.label||item.host||item.id;
  lines.push('\n'+(item.ok?'✓ ':'✗ ')+name+' ('+item.host+')');
  if(!item.ok){lines.push(message(item.error??result.error));if(result.diagnostic?.warnings?.length)lines.push('설정 경고: '+result.diagnostic.warnings.join(', '));continue;}
  if(report.action==='sync')lines.push(result.changed?'모델 목록을 갱신했습니다.':'모델 목록에 변경이 없습니다.');
  else if(report.action==='doctor')lines.push('브리지: '+(result.bridge?.ok?'정상':'확인 필요')+' · 카탈로그: '+(result.catalog?.ok?'정상':'확인 필요')+' · 원문 복구: '+(result.mcp?.ok?'정상':'확인 필요'));
  else{
   if(report.action==='apply')lines.push('저장된 연결 설정을 적용했습니다.');
   if(result.upstreamUrl)lines.push(result.upstreamUrl);
   lines.push('압축 '+(result.compression?'ON':'OFF')+' · '+(result.clientAuthMode==='server'?'서버 계정':result.clientAuthMode==='forward'?'PC 로그인 전달':'계정 인증 확인 필요'));
   lines.push('브리지: '+(result.bridge?.ok?'정상':'확인 필요')+' · Pod: '+(result.gateway?.ok?'정상':'확인 필요')+' · 모델 '+(result.catalog?.count??0)+'개');
   if(result.canApply===false)lines.push(message('REMOTE_CONTROL_UPGRADE_REQUIRED'));
  }
  if(result.restartCodex)lines.push('이 PC의 Codex를 재시작하세요.');
  if(result.warnings?.length)lines.push('설정 경고: '+result.warnings.join(', '));
 }
 return lines.join('\n');
}
function remoteSelectionChanged(){setText($('remote-selection-count'),remoteSelected.size+'대 선택');}
function setControls(){
 const disabled=!statusAvailable||lastStatus?.busy===true||settingsSaving||registrySaving;
 document.querySelectorAll('[data-mutating]').forEach(button=>button.disabled=disabled);
 for(const row of remoteRows.values())for(const button of row.controls)button.disabled=disabled;
}
function renderRemoteClients(s){
 const supported=s.capabilities?.remoteClientManagement===1;
 $('remote-client-controls').hidden=!supported;$('remote-client-unavailable').hidden=supported;
 const targets=Array.isArray(s.remoteClients)?s.remoteClients:[];
 remoteTargets=targets;
 const valid=new Set(targets.map(target=>target.id));for(const id of remoteSelected)if(!valid.has(id))remoteSelected.delete(id);
 const signature=JSON.stringify(targets);
 if(signature!==remoteSignature){
  remoteSignature=signature;remoteRows.clear();const rows=[];
  for(const target of targets){
   const row=document.createElement('div');row.className='client-row';
   const label=document.createElement('label');label.className='client-choice';
   const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id='remote-check-'+target.id;checkbox.checked=remoteSelected.has(target.id);
   checkbox.addEventListener('change',()=>{if(checkbox.checked)remoteSelected.add(target.id);else remoteSelected.delete(target.id);remoteSelectionChanged();});
   const description=document.createElement('span');description.className='client-description';
   const title=document.createElement('strong');title.textContent=target.label||target.host;
   const details=document.createElement('small');details.textContent=target.host+':'+(target.port??22)+' · '+(target.platform==='windows'?'Windows':'Linux / WSL')+'\n'+target.configPath;
   description.append(title,details);label.append(checkbox,description);
   const actions=document.createElement('div');actions.className='client-row-actions';
   const edit=document.createElement('button');edit.type='button';edit.id='remote-edit-'+target.id;edit.className='secondary';edit.textContent='수정';edit.addEventListener('click',()=>editRemoteTarget(target));
   const remove=document.createElement('button');remove.type='button';remove.id='remote-remove-'+target.id;remove.className='secondary';remove.textContent='등록 삭제';remove.addEventListener('click',()=>confirmRemoveTarget(target));
   actions.append(edit,remove);row.append(label,actions);rows.push(row);remoteRows.set(target.id,{checkbox,controls:[checkbox,edit,remove]});
  }
  $('remote-client-list').replaceChildren(...rows);
 }
 $('remote-client-empty').hidden=targets.length!==0;remoteSelectionChanged();
 setText($('remote-saved-settings'),'적용할 저장된 설정: '+s.settings.upstreamUrl+' · 압축 '+(s.settings.compression?'ON':'OFF')+' · '+(s.settings.clientAuthMode==='server'?'서버 계정':'PC 로그인 전달'));
}
function editRemoteTarget(target={}){
 remoteFormRevision++;
 for(const [field,key] of [['id','id'],['label','label'],['host','host'],['config','configPath'],['key','keyFile'],['node','nodePath']])$('remote-'+field).value=target[key]??'';
 $('remote-platform').value=target.platform??'linux';$('remote-port').value=target.port??22;
 $('remote-save').textContent=target.id?'PC 수정 저장':'PC 등록';$('remote-client-editor').open=true;
}
function confirmRemoveTarget(target){
 remotePending={remove:target.id};
 $('remote-confirm-title').textContent='이 PC 등록을 삭제할까요?';$('remote-confirm-detail').textContent=(target.label||target.host)+' ('+target.host+')';
 $('remote-confirm-help').textContent='이 제어 페이지의 등록만 삭제합니다. 대상 PC의 브리지와 설정 파일은 유지됩니다.';
 $('remote-confirm-apply').textContent='등록 삭제';$('remote-confirm').returnValue='';$('remote-confirm').showModal();
}
async function remoteAction(action){
 const ids=remoteTargets.filter(target=>remoteSelected.has(target.id)).map(target=>target.id);
 if(!ids.length){notice(message('INVALID_REMOTE_SELECTION'),true);return;}
 if(action!=='apply')return job('remote-client-action',{action,ids});
 if(settingsDirty){notice(message('REMOTE_SETTINGS_UNSAVED'),true);return;}
 const settings=lastStatus.settings;
 remotePending={action,ids,confirm:true};
 $('remote-confirm-title').textContent='선택한 PC에 연결 설정을 적용할까요?';
 $('remote-confirm-detail').textContent=remoteTargets.filter(target=>ids.includes(target.id)).map(target=>(target.label||target.host)+' ('+target.host+')').join('\n')+'\n\nPod: '+settings.upstreamUrl+'\n압축 '+(settings.compression?'ON':'OFF')+' · '+(settings.clientAuthMode==='server'?'서버 계정':'PC 로그인 전달');
 $('remote-confirm-help').textContent='저장된 인증키도 SSH를 통해 전달합니다. 각 PC의 로컬 포트와 로그인 파일은 유지됩니다. 변경 후 대상 PC의 Codex를 재시작하세요.';
 $('remote-confirm-apply').textContent='연결 설정 적용';$('remote-confirm').returnValue='';$('remote-confirm').showModal();
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
  $('client-auth-mode').value=s.settings.clientAuthMode??'forward';
  $('ssh-host').value=s.settings.management?.host??'';$('ssh-key').value=s.settings.management?.keyFile??'';$('ssh-repo').value=s.settings.management?.repo??'';showRoute();
 }
 statusAvailable=true;
 renderRemoteClients(s);setControls();
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
   setControls();
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
  const r=await api('settings',{upstreamUrl:$('upstream').value.trim(),key,compression:$('compression').checked,clientAuthMode:$('client-auth-mode').value,management});
  if($('gateway-key').value===key)$('gateway-key').value='';if(settingsRevision===revision){settingsDirty=false;settingsRevision++;}
  notice(r.message);await refreshAfterAction();
 }catch(error){notice(message(error.message),true);}
 finally{settingsSaving=false;setControls();}
});
for(const [id,action] of [['sync','sync'],['doctor','doctor'],['check-update','check-update'],['server-catalog','refresh-server-catalog']])$(id).addEventListener('click',()=>job(action));
for(const component of Object.keys(components))$(component+'-version').addEventListener('input',()=>{versionDirty.add(component);});
let update;
function confirmUpdates(names,batch){
 if(!names.length){notice(message('INVALID_UPDATE_SELECTION'),true);return;}
 const updates=names.map(component=>({component,version:$(component+'-version').value.trim()}));
 if(updates.some(item=>!/^\d+\.\d+\.\d+$/.test(item.version))){notice(message('INVALID_VERSION'),true);return;}
 update=batch?{updates}:updates[0];
 $('confirm-detail').textContent=updates.map(({component,version})=>components[component]+' '+(versions[component]?.current??'현재 버전')+' → '+version).join('\n');
 $('confirm').returnValue='';$('confirm').showModal();
}
document.querySelectorAll('[data-update]').forEach(button=>button.addEventListener('click',()=>{
 confirmUpdates([button.dataset.update],false);
}));
for(const component of Object.keys(components))$(component+'-selected').addEventListener('change',selectionChanged);
$('select-all-updates').addEventListener('click',()=>{for(const component of Object.keys(components))$(component+'-selected').checked=true;selectionChanged();});
$('update-selected').addEventListener('click',()=>confirmUpdates(selectedUpdates(),true));
$('confirm').addEventListener('close',()=>{if($('confirm').returnValue==='apply'&&update)job('update',{...update,confirm:true});update=null;});
for(const event of ['input','change'])$('remote-client-form').addEventListener(event,()=>{remoteFormRevision++;});
$('remote-client-form').addEventListener('submit',async event=>{
 event.preventDefault();const revision=remoteFormRevision;
 const target={host:$('remote-host').value.trim(),label:$('remote-label').value.trim(),platform:$('remote-platform').value||'linux',port:Number($('remote-port').value||22),configPath:$('remote-config').value.trim()};
 for(const [field,key] of [['id','id'],['key','keyFile'],['node','nodePath']]){const value=$('remote-'+field).value.trim();if(value)target[key]=value;}
 registrySaving=true;setControls();
 try{await api('remote-clients',{target});if(remoteFormRevision===revision)editRemoteTarget();notice('PC 등록을 저장했습니다. 선택한 PC의 상태를 확인하거나 연결 설정을 적용하세요.');await refreshAfterAction();}
 catch(error){notice(message(error.message),true);}finally{registrySaving=false;setControls();}
});
$('remote-reset').addEventListener('click',()=>editRemoteTarget());
$('remote-select-all').addEventListener('click',()=>{for(const target of remoteTargets){remoteSelected.add(target.id);remoteRows.get(target.id).checkbox.checked=true;}remoteSelectionChanged();});
$('remote-select-none').addEventListener('click',()=>{remoteSelected.clear();for(const row of remoteRows.values())row.checkbox.checked=false;remoteSelectionChanged();});
for(const action of ['apply','status','sync','doctor'])$('remote-'+action).addEventListener('click',()=>remoteAction(action));
$('remote-confirm').addEventListener('close',async()=>{
 const pending=remotePending;remotePending=null;if($('remote-confirm').returnValue!=='apply'||!pending)return;
 if(pending.remove){registrySaving=true;setControls();try{await api('remote-clients',pending);notice('PC 등록을 삭제했습니다. 원격 PC의 설정은 유지됩니다.');await refreshAfterAction();}catch(error){notice(message(error.message),true);}finally{registrySaving=false;setControls();}}
 else await job('remote-client-action',pending);
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else refresh();});
window.addEventListener('focus',()=>{if(!document.hidden)refresh();});
refresh();
