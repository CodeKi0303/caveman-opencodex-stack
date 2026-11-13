import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../scripts/control-ui/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../scripts/control-ui/index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function node(attributes=''){
 const handlers=new Map();let text='';
 return {textWrites:0,get textContent(){return text;},set textContent(value){text=value;this.textWrites++;},value:'',checked:false,hidden:/\bhidden\b/.test(attributes),disabled:false,readOnly:false,className:'',dataset:{},children:[],
  append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
  addEventListener(name,callback){const callbacks=handlers.get(name)??[];callbacks.push(callback);handlers.set(name,callbacks);},
  async dispatch(name,event={}){for(const callback of handlers.get(name)??[])await callback({preventDefault(){},...event});},
  showModal(){this.open=true;}};
}
async function fixture({initialFailure=false}={}){
 const elements=new Map(),mutating=[],updates=[],created=[];
 for(const tag of html.matchAll(/<[^!][^>]*>/g)){
  const id=/\bid="([^"]+)"/.exec(tag[0]);
  if(!id&&!/\bdata-mutating\b/.test(tag[0]))continue;
  const element=node(tag[0]);if(id)elements.set(id[1],element);
  if(/\bdata-mutating\b/.test(tag[0]))mutating.push(element);
  const update=/\bdata-update="([^"]+)"/.exec(tag[0]);if(update){element.dataset.update=update[1];updates.push(element);}
 }
 const document=node(),window=node();document.hidden=false;
 const nested=values=>values.flatMap(value=>[value,...nested(value.children)]);
 document.getElementById=id=>{const element=elements.get(id)??nested([...elements.values()]).find(value=>value.id===id);assert(element,'HTML must provide '+id);return element;};
 document.createElement=()=>{const element=node();created.push(element);return element;};
 document.querySelector=selector=>{assert.equal(selector,'meta[name="control-token"]');return {content:'fixture-control-token'};};
 document.querySelectorAll=selector=>{assert(['[data-mutating]','[data-update]'].includes(selector));return selector==='[data-mutating]'?mutating:updates;};
 const timers=new Map();let sequence=0,activeRequests=0,maxActive=0;
 const calls=[],state={failure:initialFailure,hold:null,action:null,status:{
  ok:true,checkedAt:'2026-10-19T01:00:00.000Z',
  capabilities:{remoteClientManagement:1},remoteClients:[],settings:{upstreamUrl:'http://server.test/v1',compression:true,clientAuthMode:'server',management:null},
  bridge:{ok:true},gateway:{ok:true},catalog:{count:9,modified:'2026-10-18T01:00:00.000Z'},
  authentication:{mode:'pool',source:'server'},alerts:[],job:null,busy:false,
 }};
 const fetch=async(url,options)=>{
  calls.push({url,method:options.method,body:options.body});
  if(url!=='/api/status'){if(state.actionHold)await state.actionHold.promise;return {ok:true,json:async()=>state.action??{ok:true,message:'설정을 저장했습니다.'}};}
  activeRequests++;maxActive=Math.max(maxActive,activeRequests);
  try{
   if(state.hold)await state.hold.promise;
   if(state.failure)throw Error('private transport details');
   return {ok:!state.httpError,json:async()=>state.httpError?{error:state.httpError}:structuredClone(state.status)};
  }finally{activeRequests--;}
 };
 const context=vm.createContext({document,window,fetch,AbortSignal:{timeout:()=>({})},setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
 vm.runInContext(source,context);await settle();
 const element=id=>document.getElementById(id);
 const tick=async()=>{assert.equal(timers.size,1,'exactly one next refresh is scheduled');const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.fn();await settle();};
 return {element,document,window,timers,state,calls,mutating,updates,tick,maxActive:()=>maxActive,settle};
}

test('idle status and alerts refresh without triggering catalog sync or any other mutation',async()=>{
 const f=await fixture();assert.equal(f.element('authentication-status').textContent,'서버 계정 풀');
 assert.equal([...f.timers.values()][0].delay,10000);
 f.state.status.alerts=[{id:'pool',severity:'warning',message:'계정 상태 확인 필요'}];
 await f.tick();assert.equal(f.element('health-alerts').hidden,false);assert.match(f.element('health-alert-text').textContent,/계정 상태/);
 assert.equal(f.calls.length,2);assert(f.calls.every(call=>call.url==='/api/status'&&call.method==='GET'));
 f.state.status.busy=true;await f.tick();assert.equal([...f.timers.values()][0].delay,2500);assert(f.mutating.every(button=>button.disabled));
 f.state.status.busy=false;f.state.status.authentication={mode:'direct',source:'server'};await f.tick();assert.match(f.element('authentication-status').textContent,/요청별 계정 선택/);
 f.state.status.authentication={mode:'unknown',source:'unavailable'};await f.tick();assert.equal(f.element('authentication-status').textContent,'서버 설정 확인 필요');
});

test('failed polling retries, labels stale data and clears recovered health alerts without removing a job notice',async()=>{
 const f=await fixture();f.state.status.job={id:'failure-1',action:'doctor',status:'failed',error:'DOCTOR_FAILED'};
 await f.tick();assert.equal(f.element('notice').hidden,false);const notice=f.element('notice-text').textContent;
 f.state.failure=true;await f.tick();assert.equal(f.element('health-alerts').hidden,false);assert.match(f.element('status-updated').textContent,/갱신 실패.*마지막 확인/);assert(f.mutating.every(button=>button.disabled));
 assert.equal([...f.timers.values()][0].delay,10000);assert(!f.element('health-alert-text').textContent.includes('private'));
 f.state.failure=false;await f.tick();assert.equal(f.element('health-alerts').hidden,true);assert.equal(f.element('notice-text').textContent,notice);assert.equal(f.element('notice').hidden,false);assert(!f.element('status-updated').textContent.includes('실패'));
 await f.element('dismiss-notice').dispatch('click');await f.tick();assert.equal(f.element('notice').hidden,true,'dismissed terminal job must not announce again on every poll');
});
test('model counts show selectable and hidden totals, refresh visibility-only changes and support legacy status',async()=>{
 const f=await fixture();assert.equal(f.element('catalog-summary').hidden,true);assert.equal(f.element('model-count').textContent,9);
 f.state.status.catalog={count:3,totalCount:9,hiddenCount:6,modified:'2026-10-18T01:00:00.000Z'};
 await f.tick();assert.equal(f.element('model-count').textContent,3);assert.equal(f.element('catalog-status').textContent,'선택 가능 3개');
 assert.equal(f.element('catalog-summary').hidden,false);assert.equal(f.element('catalog-summary').textContent,'전체 9개 · 숨김 6개');
 f.state.status.catalog.count=2;f.state.status.catalog.hiddenCount=7;
 await f.tick();assert.equal(f.element('model-count').textContent,2);assert.equal(f.element('catalog-summary').textContent,'전체 9개 · 숨김 7개');
 f.state.status.catalog.count=0;f.state.status.catalog.hiddenCount=9;
 f.state.status.alerts=[{id:'catalog-no-selectable',severity:'warning',message:'선택 가능한 로컬 모델이 없습니다.'}];
 await f.tick();assert.equal(f.element('model-count').textContent,0);assert.equal(f.element('catalog-summary').textContent,'전체 9개 · 숨김 9개');
 assert.equal(f.element('health-alerts').hidden,false);assert.match(f.element('health-alert-text').textContent,/선택 가능한/);
 f.state.status.catalog={count:9};f.state.status.alerts=[];await f.tick();
 assert.equal(f.element('catalog-summary').hidden,true);assert.equal(f.element('catalog-summary').textContent,'');
 assert(f.calls.every(call=>call.url==='/api/status'&&call.method==='GET'),'refreshing counts must not synchronize or modify settings');
});

test('initial connectivity failure recovers, while a restarted control process asks for browser reload',async()=>{
 const f=await fixture({initialFailure:true});assert.match(f.element('status-updated').textContent,/아직 상태/);assert.equal(f.timers.size,1);
 f.state.failure=false;await f.tick();assert.equal(f.element('health-alerts').hidden,true);
 f.state.httpError='CONTROL_TOKEN_REQUIRED';await f.tick();assert.match(f.element('health-alert-text').textContent,/브라우저를 새로고침/);assert.equal(f.timers.size,1);
});

test('focus and manual refresh share one in-flight read, hidden pages pause and resume',async()=>{
 const f=await fixture(),hold=deferred();f.state.hold=hold;
 const manual=f.element('refresh').dispatch('click'),focus=f.window.dispatch('focus');await settle();
 assert.equal(f.calls.length,2);assert.equal(f.maxActive(),1);assert.equal(f.timers.size,0);
 f.document.hidden=true;await f.document.dispatch('visibilitychange');hold.resolve();await Promise.all([manual,focus]);await settle();assert.equal(f.timers.size,0);
 f.state.hold=null;f.document.hidden=false;await f.document.dispatch('visibilitychange');await settle();assert.equal(f.calls.length,3);assert.equal(f.timers.size,1);
 f.document.hidden=true;await f.document.dispatch('visibilitychange');assert.equal(f.timers.size,0);
 await f.window.dispatch('focus');assert.equal(f.calls.length,3);
});

test('status refresh updates untouched settings but preserves unsaved settings and all three chosen package versions',async()=>{
 const f=await fixture();f.state.status.settings.upstreamUrl='http://changed.test/v1';f.state.status.settings.compression=false;
 await f.tick();assert.equal(f.element('upstream').value,'http://changed.test/v1');assert.equal(f.element('compression').checked,false);
 f.element('upstream').value='http://editing.test/v1';await f.element('settings-form').dispatch('input');
 f.state.status.settings.upstreamUrl='http://newer.test/v1';await f.tick();assert.equal(f.element('upstream').value,'http://editing.test/v1');
 const components={caveman:{current:'1.0.0',latest:'1.2.0'},opencodex:{current:'2.0.0',latest:'2.1.0'},codex:{current:'0.161.0',latest:'0.162.1'}};
 f.state.status.job={id:'versions',action:'check-update',status:'succeeded',result:{components}};
 await f.tick();
 for(const [component,version] of Object.entries(components)){
  assert.equal(f.element(component+'-version').value,version.latest);
  assert.equal(f.element(component+'-current').textContent,version.current);
  assert.equal(f.element(component+'-latest').textContent,version.latest);
  f.element(component+'-version').value=version.current;await f.element(component+'-version').dispatch('input');
 }
 await f.tick();
 for(const [component,version] of Object.entries(components))assert.equal(f.element(component+'-version').value,version.current,'polling must preserve the selected '+component+' version');
});

test('current alert messages render as literal text and old servers do not imply client authentication',async()=>{
 const f=await fixture();f.state.status.alerts=[{id:'literal',severity:'error',message:'<img src=x onerror=alert(1)>'}];delete f.state.status.authentication;
 await f.tick();assert.equal(f.element('health-alert-text').textContent,'<img src=x onerror=alert(1)>');assert.equal(f.element('health-alerts').className,'notice error');assert.equal(f.element('authentication-status').textContent,'서버 설정 확인 필요');
 delete f.state.status.alerts;f.state.status.gateway.ok=false;await f.tick();assert.match(f.element('health-alert-text').textContent,/서버 연결/);
});

test('saving keeps controls locked while polling and preserves edits made before the save finishes',async()=>{
 const f=await fixture(),hold=deferred();f.state.actionHold=hold;
 f.element('upstream').value='http://saved.test/v1';f.element('gateway-key').value='fixture-key';await f.element('settings-form').dispatch('input');
 const button=f.mutating[0],saving=f.element('settings-form').dispatch('submit',{submitter:button});await settle();
 await f.tick();assert(f.mutating.every(element=>element.disabled));
 f.element('upstream').value='http://still-editing.test/v1';f.element('gateway-key').value='next-fixture-key';await f.element('settings-form').dispatch('input');
 f.state.status.settings.upstreamUrl='http://saved.test/v1';hold.resolve();await saving;
 assert.equal(f.element('upstream').value,'http://still-editing.test/v1');assert.equal(f.element('gateway-key').value,'next-fixture-key');assert(f.mutating.every(element=>!element.disabled));
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.calls.find(call=>call.method==='POST').url,'/api/settings');
});

test('a succeeding job clears an older job failure, while an unrelated settings notice is preserved',async()=>{
 const f=await fixture();f.state.status.job={id:'failed',action:'doctor',status:'failed',error:'DOCTOR_FAILED'};
 await f.tick();assert.equal(f.element('notice').hidden,false);
 f.state.status.job={id:'succeeded',action:'sync',status:'succeeded',result:{changed:true}};
 await f.tick();assert.equal(f.element('notice').hidden,true);assert.match(f.element('job-result').textContent,/갱신했습니다/);
 await f.element('settings-form').dispatch('submit',{submitter:f.mutating[0]});
 assert.equal(f.element('notice').hidden,false);assert.equal(f.element('notice-text').textContent,'설정을 저장했습니다.');
 f.state.status.job={id:'another-success',action:'doctor',status:'succeeded',result:{bridge:{ok:true},catalog:{ok:true},mcp:{ok:true}}};
 await f.tick();assert.equal(f.element('notice').hidden,false);assert.equal(f.element('notice-text').textContent,'설정을 저장했습니다.');
});

test('unchanged polling does not repeatedly rewrite live announcement content',async()=>{
 const f=await fixture();f.state.status.alerts=[{id:'warning',severity:'warning',message:'연결 확인 필요'}];
 f.state.status.job={id:'working',action:'sync',status:'running'};await f.tick();
 const alerts=f.element('health-alert-text').textWrites,job=f.element('job-result').textWrites;
 await f.tick();assert.equal(f.element('health-alert-text').textWrites,alerts);assert.equal(f.element('job-result').textWrites,job);
 f.state.status.alerts=[];f.state.status.job.status='succeeded';f.state.status.job.result={changed:true};await f.tick();
 assert.equal(f.element('health-alert-text').textWrites,alerts+1);assert.equal(f.element('job-result').textWrites,job+1);
});

for(const [component,label] of Object.entries({caveman:'Caveman CLI',opencodex:'OpenCodex',codex:'Codex CLI (서버 Pod)'})){
 test(component+' update requires confirmation and posts only its selected version',async()=>{
  const f=await fixture(),button=f.updates.find(element=>element.dataset.update===component);
  assert(button,'component must have its own update button');
  f.state.status.job={id:'versions',action:'check-update',status:'succeeded',result:{components:{[component]:{current:'1.2.3',latest:'1.3.0'}}}};
  await f.tick();f.element(component+'-version').value='1.2.4';await f.element(component+'-version').dispatch('input');
  await button.dispatch('click');assert.equal(f.element('confirm').open,true);
  assert.equal(f.element('confirm-detail').textContent,label+' 1.2.3 → 1.2.4');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  f.element('confirm').returnValue='cancel';await f.element('confirm').dispatch('close');await settle();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0,'cancelling must not update');
  await button.dispatch('click');f.element('confirm').returnValue='apply';await f.element('confirm').dispatch('close');await settle();
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/update');
  assert.deepEqual(JSON.parse(posts[0].body),{component,version:'1.2.4',confirm:true});
 });
}

test('Codex update is identified as the server Pod CLI rather than the Windows desktop app',()=>{
 assert.match(html,/<h3>Codex CLI<\/h3><p>서버 Pod · 메인 계정 로그인<\/p>/);
 assert.match(html,/Windows Codex 데스크톱 앱은 여기서 업데이트하지 않습니다/);
});

test('multiple selected components share one confirmation and one immutable update plan',async()=>{
 const f=await fixture();
 const versions={caveman:{current:'4.0.2',latest:'4.0.3'},opencodex:{current:'2.99.0',latest:'2.100.2'},codex:{current:'0.163.0',latest:'0.164.0'}};
 f.state.status.job={id:'batch-versions',action:'check-update',status:'succeeded',result:{components:versions}};
 await f.tick();
 for(const component of ['opencodex','codex']){f.element(component+'-selected').checked=true;await f.element(component+'-selected').dispatch('change');}
 assert.equal(f.element('update-selection-count').textContent,'2개 선택');
 await f.tick();assert(f.element('opencodex-selected').checked);assert(f.element('codex-selected').checked);assert(!f.element('caveman-selected').checked);
 await f.element('update-selected').dispatch('click');assert.equal(f.element('confirm').open,true);
 assert.equal(f.element('confirm-detail').textContent,'OpenCodex 2.99.0 → 2.100.2\nCodex CLI (서버 Pod) 0.163.0 → 0.164.0');
 assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 f.element('opencodex-version').value='2.100.3';
 f.element('confirm').returnValue='apply';await f.element('confirm').dispatch('close');await settle();
 const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/update');
 assert.deepEqual(JSON.parse(posts[0].body),{updates:[{component:'opencodex',version:'2.100.2'},{component:'codex',version:'0.164.0'}],confirm:true});
 f.state.status.job={id:'batch-result',action:'update',status:'succeeded',result:{updates:[{component:'opencodex',version:'2.100.2'},{component:'codex',version:'0.164.0'}],message:'선택한 업데이트 완료'}};
 await f.tick();assert.equal(f.element('opencodex-current').textContent,'2.100.2');assert.equal(f.element('codex-current').textContent,'0.164.0');assert.equal(f.element('caveman-current').textContent,'4.0.2');
});

test('batch selection rejects empty or invalid versions and cancel never submits',async()=>{
 const f=await fixture();
 await f.element('update-selected').dispatch('click');assert.match(f.element('notice-text').textContent,/1개 이상/);assert(!f.element('confirm').open);
 await f.element('select-all-updates').dispatch('click');assert.equal(f.element('update-selection-count').textContent,'3개 선택');
 await f.element('update-selected').dispatch('click');assert.match(f.element('notice-text').textContent,/버전/);assert(!f.element('confirm').open);
 for(const component of ['caveman','opencodex','codex'])f.element(component+'-version').value='1.2.3';
 await f.element('update-selected').dispatch('click');assert(f.element('confirm').open);
 f.element('confirm').returnValue='cancel';await f.element('confirm').dispatch('close');await settle();
 assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

const remoteTargets=[
 {id:'linux-pc',label:'작업 Linux',host:'worker@192.0.2.20',port:22,platform:'linux',configPath:'/home/worker/.codex/caveman-stack/native-bridge.json'},
 {id:'windows-pc',label:'Windows PC',host:'user@192.0.2.21',port:2222,platform:'windows',configPath:'C:\\Users\\user\\.codex\\caveman-stack\\native-bridge.json',keyFile:'C:/keys/work',nodePath:'C:\\Program Files\\nodejs\\node.exe'}
];
async function remoteFixture(){const f=await fixture();f.state.status.remoteClients=structuredClone(remoteTargets);await f.tick();return f;}

test('PC registry polling does not connect automatically or overwrite selections and edited registration fields',async()=>{
 const f=await remoteFixture();assert.equal(f.element('remote-client-empty').hidden,true);assert.equal(f.element('remote-client-list').children.length,2);
 f.element('remote-check-linux-pc').checked=true;await f.element('remote-check-linux-pc').dispatch('change');
 await f.element('remote-edit-windows-pc').dispatch('click');assert.equal(f.element('remote-platform').value,'windows');assert.equal(f.element('remote-id').value,'windows-pc');
 f.element('remote-config').value='C:\\Users\\different\\.codex\\config.toml';await f.element('remote-client-form').dispatch('input');
 f.state.status.remoteClients[0].label='수정된 이름';await f.tick();
 assert.equal(f.element('remote-config').value,'C:\\Users\\different\\.codex\\config.toml');assert.equal(f.element('remote-check-linux-pc').checked,true);
 assert.equal(f.element('remote-selection-count').textContent,'1대 선택');assert(f.calls.every(call=>call.url==='/api/status'));
 f.state.status.remoteClients.shift();await f.tick();assert.equal(f.element('remote-selection-count').textContent,'0대 선택');
});

test('registering and editing remote PCs sends paths and target metadata without Pod credentials',async()=>{
 const f=await remoteFixture();await f.element('remote-reset').dispatch('click');
 f.element('remote-host').value='wsl-work';f.element('remote-label').value='작업 WSL';f.element('remote-config').value='/home/me/.codex/config.toml';
 await f.element('remote-client-form').dispatch('submit');
 let posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts[0].url,'/api/remote-clients');
 assert.deepEqual(JSON.parse(posts[0].body),{target:{host:'wsl-work',label:'작업 WSL',platform:'linux',port:22,configPath:'/home/me/.codex/config.toml'}});
 await f.element('remote-edit-windows-pc').dispatch('click');f.element('remote-label').value='새 Windows 이름';
 await f.element('remote-client-form').dispatch('submit');posts=f.calls.filter(call=>call.method==='POST');
 assert.deepEqual(JSON.parse(posts[1].body),{target:{...remoteTargets[1],label:'새 Windows 이름'}});
 assert(!posts.some(call=>call.body.includes('gateway-key')||call.body.includes('auth.json')));
});

test('remote apply confirms selected PCs and saved settings, then sends one frozen target selection',async()=>{
 const f=await remoteFixture();await f.element('remote-select-all').dispatch('click');assert.equal(f.element('remote-selection-count').textContent,'2대 선택');
 await f.element('remote-apply').dispatch('click');assert.equal(f.element('remote-confirm').open,true);assert.match(f.element('remote-confirm-detail').textContent,/작업 Linux.*192\.0\.2\.20/);assert.match(f.element('remote-confirm-detail').textContent,/http:\/\/server\.test\/v1/);assert.match(f.element('remote-confirm-detail').textContent,/서버 계정/);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 await f.element('remote-select-none').dispatch('click');f.element('remote-confirm').returnValue='apply';await f.element('remote-confirm').dispatch('close');
 const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/remote-client-action');
 assert.deepEqual(JSON.parse(posts[0].body),{action:'apply',ids:['linux-pc','windows-pc'],confirm:true});
});

test('remote apply rejects an empty selection or unsaved local settings and cancel does not run it',async()=>{
 const f=await remoteFixture();await f.element('remote-apply').dispatch('click');assert.match(f.element('notice-text').textContent,/1대 이상/);
 await f.element('remote-select-all').dispatch('click');await f.element('remote-apply').dispatch('click');f.element('remote-confirm').returnValue='cancel';await f.element('remote-confirm').dispatch('close');
 f.element('upstream').value='http://unsaved.test/v1';await f.element('settings-form').dispatch('input');await f.element('remote-apply').dispatch('click');
 assert.match(f.element('notice-text').textContent,/먼저.*저장/);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

test('remote status sync and diagnosis submit selected targets without changing their Pod configuration',async()=>{
 const f=await remoteFixture();f.element('remote-check-linux-pc').checked=true;await f.element('remote-check-linux-pc').dispatch('change');
 for(const action of ['status','sync','doctor'])await f.element('remote-'+action).dispatch('click');
 const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,3);
 for(const [index,action] of ['status','sync','doctor'].entries())assert.deepEqual(JSON.parse(posts[index].body),{action,ids:['linux-pc']});
 assert(posts.every(call=>call.url==='/api/remote-client-action'));assert(!f.element('remote-confirm').open);
});

test('removing a PC requires confirmation and only removes its local registration',async()=>{
 const f=await remoteFixture();await f.element('remote-remove-linux-pc').dispatch('click');assert.match(f.element('remote-confirm-help').textContent,/설정 파일은 유지/);
 f.element('remote-confirm').returnValue='cancel';await f.element('remote-confirm').dispatch('close');assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 await f.element('remote-remove-linux-pc').dispatch('click');f.element('remote-confirm').returnValue='apply';await f.element('remote-confirm').dispatch('close');
 const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/remote-clients');assert.deepEqual(JSON.parse(posts[0].body),{remove:'linux-pc'});
});

test('partial remote failures keep successful PC results visible and render remote names as text',async()=>{
 const f=await remoteFixture();f.state.status.job={id:'remote-result',action:'remote-client-action',status:'failed',error:'REMOTE_CLIENTS_PARTIAL_FAILURE',result:{ok:false,action:'apply',results:[
  {id:'linux-pc',label:'<img src=x onerror=alert(1)>',host:'worker@192.0.2.20',ok:true,result:{applied:true,upstreamUrl:'http://server.test/v1',compression:true,clientAuthMode:'server',bridge:{ok:true},gateway:{ok:true},catalog:{count:3},restartCodex:true}},
  {id:'windows-pc',label:'Windows PC',host:'user@192.0.2.21',ok:false,error:'REMOTE_SSH_FAILED'}]}};
 await f.tick();const result=f.element('job-result').textContent;
 assert.match(result,/완료 1대 · 실패 1대/);assert.match(result,/<img src=x onerror=alert\(1\)>/);assert.match(result,/연결 설정을 적용했습니다/);assert.match(result,/Codex를 재시작/);assert.match(result,/Windows PC/);assert.match(result,/SSH 계정/);
 assert.equal(f.element('notice-text').textContent,result);
});

test('client authentication selector follows saved settings and preserves unsaved choice during polling',async()=>{
 const f=await fixture();assert.equal(f.element('client-auth-mode').value,'server');
 f.element('client-auth-mode').value='forward';await f.element('settings-form').dispatch('change');await f.tick();assert.equal(f.element('client-auth-mode').value,'forward');
 await f.element('settings-form').dispatch('submit');const post=f.calls.find(call=>call.url==='/api/settings');assert.equal(JSON.parse(post.body).clientAuthMode,'forward');
});

test('saving the registry locks controls and retains edits made while the request is pending',async()=>{
 const f=await remoteFixture(),hold=deferred();f.state.actionHold=hold;
 await f.element('remote-edit-linux-pc').dispatch('click');const saving=f.element('remote-client-form').dispatch('submit');await settle();await f.tick();assert(f.mutating.every(element=>element.disabled));
 assert.equal(f.element('remote-check-linux-pc').disabled,true);
 f.element('remote-label').value='계속 편집 중';await f.element('remote-client-form').dispatch('input');hold.resolve();await saving;
 assert.equal(f.element('remote-label').value,'계속 편집 중');assert.equal(f.element('remote-id').value,'linux-pc');assert(f.mutating.every(element=>!element.disabled));
});

test('cache-only sync repair is visible even when the server catalog did not change',async()=>{
 const f=await fixture();f.state.status.job={id:'repair',action:'sync',status:'succeeded',result:{ok:true,changed:true,catalogChanged:false,cacheChanged:true,cacheRepaired:true,restartCodex:true,warnings:[]}};
 await f.tick();assert.match(f.element('job-result').textContent,/Codex 캐시 복구/);assert.match(f.element('job-result').textContent,/Codex를 재시작/);
 assert(!f.element('job-result').textContent.includes('변경이 없습니다'));
});

test('a successful server update with a failed client shows partial completion and applied versions',async()=>{
 const f=await fixture();f.state.status.job={id:'linked',action:'update',status:'partial',result:{ok:true,serverApplied:true,updates:[{component:'opencodex',version:'2.100.2'}],message:'서버 작업은 완료했습니다.',clientSync:{ok:false,local:{ok:true,cacheRepaired:true},remote:{ok:false,action:'sync',results:[
  {id:'good',label:'온라인 PC',host:'good.test',ok:true,result:{ok:true,configChanged:true,restartCodex:true}},
  {id:'other',label:'다른 Pod PC',host:'other.test',ok:true,result:{ok:true,skipped:true,reason:'REMOTE_POD_MISMATCH'}},
  {id:'bad',label:'꺼진 PC',host:'bad.test',ok:false,error:'REMOTE_SSH_FAILED'}]}}}};
 await f.tick();const text=f.element('job-result').textContent;
 assert.equal(f.element('job-badge').textContent,'부분 완료');assert.equal(f.element('opencodex-current').textContent,'2.100.2');
 assert.match(text,/서버 작업은 완료/);assert.match(text,/이 PC: Codex 캐시 복구/);
 assert.match(text,/완료 1대 · 실패 1대 · 건너뜀 1대/);assert.match(text,/다른 Pod에 연결/);assert.match(text,/꺼진 PC/);
 assert.equal(f.element('notice').hidden,false);assert(!f.element('notice').className.includes('error'));
});

test('server catalog refresh is one explicit action and periodic polling never starts the linked sync',async()=>{
 const f=await fixture();assert.match(html,/서버 갱신 \+ PC 동기화/);
 await f.tick();await f.tick();assert(f.calls.every(c=>c.method==='GET'));
 await f.element('server-catalog').dispatch('click');await settle();
 const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/refresh-server-catalog');
});
