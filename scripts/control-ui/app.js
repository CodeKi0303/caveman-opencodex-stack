const $=id=>document.getElementById(id),token=document.querySelector('meta[name="control-token"]').content;
let initial=false,timer,lastJob,versions={};
const errors={GATEWAY_KEY_REJECTED:'서버가 인증키를 거부했습니다.',GATEWAY_UNAVAILABLE:'서버에 연결할 수 없습니다.',INVALID_URL:'API 주소는 http(s)://호스트:포트/v1 형식이어야 합니다.',INVALID_KEY:'인증키는 줄바꿈 없이 32자 이상이어야 합니다.',SERVER_UPGRADE_REQUIRED:'서버 게이트웨이를 먼저 업데이트해야 이 기능을 사용할 수 있습니다.',BRIDGE_UPGRADE_REQUIRED:'로컬 브리지를 먼저 업데이트해 주세요.',SSH_NOT_CONFIGURED:'서버 업데이트용 SSH 연결을 먼저 저장하세요.',SSH_TARGET_MISMATCH:'SSH 대상과 Pod 주소의 호스트가 다릅니다. 연결 설정을 확인하세요.',SSH_UNAVAILABLE:'SSH를 실행할 수 없습니다.',SERVER_OPERATION_FAILED:'서버 작업이 실패했습니다. 서버 상태와 비공개 작업 로그를 확인하세요.',SERVER_BUSY:'다른 서버 작업이 실행 중입니다.',OPERATION_BUSY:'현재 작업이 끝난 후 다시 시도하세요.',INVALID_VERSION:'버전은 숫자.숫자.숫자 형식으로 입력하세요.',INSUFFICIENT_DISK:'서버에 최소 4 GiB 여유 공간이 필요합니다.',INVALID_SSH_SETTINGS:'SSH 대상·개인키 경로·서버 디렉터리를 확인하세요.',SSH_KEY_UNREADABLE:'SSH 개인키 파일을 읽을 수 없습니다.',DOCTOR_FAILED:'연결 진단에서 문제가 발견됐습니다. 결과를 확인하세요.'};
const message=e=>errors[e]??('작업을 완료하지 못했습니다. ('+e+')');
function notice(text,error=false){$('notice').hidden=false;$('notice').textContent=text;$('notice').className='notice'+(error?' error':'');}
async function api(route,body){const r=await fetch('/api/'+route,{method:body===undefined?'GET':'POST',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw Error(data.error||'OPERATION_FAILED');return data;}
function showRoute(){const on=$('compression').checked;$('route-compression').textContent=on?'Caveman':'압축 건너뛰기';$('compression-text').textContent=on?'새 모델 요청에 압축을 적용합니다.':'OpenCodex로 직접 전달합니다.';}
function renderResult(job){
 const labels={sync:'모델 카탈로그 동기화',doctor:'연결 진단','check-update':'서버 버전 확인',update:'서버 업데이트','refresh-server-catalog':'서버 카탈로그 갱신'};
 $('job-badge').textContent=job.status==='running'?'실행 중':job.status==='succeeded'?'완료':'실패';$('job-title').textContent=labels[job.action]??job.action;
 if(job.status==='running'){$('job-result').textContent=job.action==='update'?'버전 준비 → 이미지 빌드 → 후보 검사 → 백업 및 적용\n몇 분이 걸릴 수 있습니다.':'연결을 확인하고 있습니다…';return;}
 const r=job.result;
 if(r?.components){versions=r.components;for(const c of ['caveman','opencodex']){const v=versions[c];$(c+'-current').textContent=v.current??'—';$(c+'-latest').textContent=v.latest??'확인 실패';$(c+'-version').value=v.latest??v.current??'';}}
 let text=job.error?message(job.error):r?.message??(job.action==='sync'?(r.changed?'모델 목록을 갱신했습니다.':'모델 목록에 변경이 없습니다.'):(job.action==='doctor'?'연결 진단을 완료했습니다.':'버전을 확인했습니다.'));
 if(r?.restartCodex)text+='\n새 목록을 사용하려면 Codex를 재시작하세요.';
 if(r?.warnings?.length)text+='\n설정 경고: '+r.warnings.join(', ');
 if(job.action==='doctor'&&r)text+='\n브리지: '+(r.bridge?.ok?'정상':'확인 필요')+' · 카탈로그: '+(r.catalog?.ok?'정상':'확인 필요')+' · 원문 복구: '+(r.mcp?.ok?'정상':'확인 필요');
 if(r?.jobId)text+='\n서버 작업 ID: '+r.jobId;
 $('job-result').textContent=text;
 if(job.status==='failed'&&lastJob!==job.id)notice(text,true);lastJob=job.id;
}
async function refresh(){clearTimeout(timer);try{const s=await api('status');$('bridge-status').textContent=s.bridge.ok?'● 정상 연결':'○ 연결 확인 필요';$('gateway-status').textContent=s.gateway.ok?'● 인증 확인됨':'○ 연결 또는 버전 확인';$('catalog-status').textContent=s.catalog.count+'개 모델';$('model-count').textContent=s.catalog.count;$('catalog-date').textContent='마지막 로컬 변경 '+(s.catalog.modified?new Date(s.catalog.modified).toLocaleString('ko-KR'):'—');
 if(!initial){$('upstream').value=s.settings.upstreamUrl;$('compression').checked=s.settings.compression;$('ssh-host').value=s.settings.management?.host??'';$('ssh-key').value=s.settings.management?.keyFile??'';$('ssh-repo').value=s.settings.management?.repo??'';showRoute();initial=true;}
 document.querySelectorAll('[data-mutating]').forEach(b=>b.disabled=s.busy);if(s.job)renderResult(s.job);if(s.busy)timer=setTimeout(refresh,2500);
 }catch(e){notice(message(e.message),true);}}
async function job(action,body={}){try{await api(action,body);await refresh();}catch(e){notice(message(e.message),true);}}
$('compression').addEventListener('change',showRoute);$('refresh').addEventListener('click',refresh);
$('settings-form').addEventListener('submit',async e=>{e.preventDefault();const host=$('ssh-host').value.trim(),management=host?{host,keyFile:$('ssh-key').value.trim(),repo:$('ssh-repo').value.trim()}:null;const button=e.submitter;button.disabled=true;try{const r=await api('settings',{upstreamUrl:$('upstream').value.trim(),key:$('gateway-key').value,compression:$('compression').checked,management});$('gateway-key').value='';notice(r.message);await refresh();}catch(error){notice(message(error.message),true);}finally{button.disabled=false;}});
for(const [id,action] of [['sync','sync'],['doctor','doctor'],['check-update','check-update'],['server-catalog','refresh-server-catalog']])$(id).addEventListener('click',()=>job(action));
let update;
document.querySelectorAll('[data-update]').forEach(button=>button.addEventListener('click',()=>{const component=button.dataset.update,version=$(component+'-version').value.trim();if(!/^\d+\.\d+\.\d+$/.test(version)){notice(message('INVALID_VERSION'),true);return;}update={component,version};$('confirm-detail').textContent=(component==='caveman'?'Caveman CLI':'OpenCodex')+' '+(versions[component]?.current??'현재 버전')+' → '+version;$('confirm').showModal();}));
$('confirm').addEventListener('close',()=>{if($('confirm').returnValue==='apply'&&update)job('update',{...update,confirm:true});update=null;});
refresh();
