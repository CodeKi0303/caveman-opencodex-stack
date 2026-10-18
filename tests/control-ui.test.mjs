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
 return {textWrites:0,get textContent(){return text;},set textContent(value){text=value;this.textWrites++;},value:'',checked:false,hidden:/\bhidden\b/.test(attributes),disabled:false,readOnly:false,className:'',dataset:{},
  addEventListener(name,callback){const callbacks=handlers.get(name)??[];callbacks.push(callback);handlers.set(name,callbacks);},
  async dispatch(name,event={}){for(const callback of handlers.get(name)??[])await callback({preventDefault(){},...event});},
  showModal(){this.open=true;}};
}
async function fixture({initialFailure=false}={}){
 const elements=new Map(),mutating=[],updates=[];
 for(const tag of html.matchAll(/<[^!][^>]*>/g)){
  const id=/\bid="([^"]+)"/.exec(tag[0]);
  if(!id&&!/\bdata-mutating\b/.test(tag[0]))continue;
  const element=node(tag[0]);if(id)elements.set(id[1],element);
  if(/\bdata-mutating\b/.test(tag[0]))mutating.push(element);
  const update=/\bdata-update="([^"]+)"/.exec(tag[0]);if(update){element.dataset.update=update[1];updates.push(element);}
 }
 const document=node(),window=node();document.hidden=false;
 document.getElementById=id=>{assert(elements.has(id),'HTML must provide '+id);return elements.get(id);};
 document.querySelector=selector=>{assert.equal(selector,'meta[name="control-token"]');return {content:'fixture-control-token'};};
 document.querySelectorAll=selector=>{assert(['[data-mutating]','[data-update]'].includes(selector));return selector==='[data-mutating]'?mutating:updates;};
 const timers=new Map();let sequence=0,activeRequests=0,maxActive=0;
 const calls=[],state={failure:initialFailure,hold:null,action:null,status:{
  ok:true,checkedAt:'2026-10-19T01:00:00.000Z',
  settings:{upstreamUrl:'http://server.test/v1',compression:true,management:null},
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
