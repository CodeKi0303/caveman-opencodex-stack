import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createRecoveryMcp} from '../src/recovery-mcp.mjs';
import {createGateway} from '../src/gateway.mjs';

const key = 'b'.repeat(64);
const fixturePath = fileURLToPath(new URL('./fixtures/mcp-backend.mjs', import.meta.url));
const headers = {'x-caveman-gateway-key':key,'content-type':'application/json',accept:'application/json, text/event-stream',
  'mcp-protocol-version':'2025-03-26'};
async function fixture(t, options = {}) {
  const bridge = createRecoveryMcp({command:process.execPath,args:[fixturePath],timeoutMs:2000,...options});
  const gateway = createGateway({key,recoveryMcp:bridge});
  gateway.listen(0,'127.0.0.1'); await once(gateway,'listening');
  t.after(async()=>{ await gateway.closeRecovery(); gateway.closeAllConnections(); await new Promise(r=>gateway.close(r)); });
  const url = 'http://127.0.0.1:'+gateway.address().port+'/mcp';
  const post = async (body, override = {}) => {
    const response = await fetch(url,{method:'POST',headers:{...headers,...override},body:JSON.stringify(body)});
    return {status:response.status, body:await response.json()};
  };
  const call = (handle, options = {}) => post({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'caveman_retrieve',arguments:{recovery_handle:handle,...options}}});
  return {url,post,call,gateway};
}

test('gateway authenticates MCP before invoking the bridge',async t=>{
  let invoked = 0;
  const gateway=createGateway({key,recoveryMcp:{handle(){invoked++;},async close(){}}});
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  t.after(()=>{gateway.closeAllConnections();gateway.close();});
  const url='http://127.0.0.1:'+gateway.address().port+'/mcp';
  for(const supplied of [{},{authorization:'Bearer client-secret'},{'x-caveman-gateway-key':'wrong'}]) {
    const response=await fetch(url,{method:'POST',headers:supplied,body:'{}'});
    assert.equal(response.status,401);await response.text();
  }
  assert.equal(invoked,0);
});

test('SDK HTTP client negotiates with frontend and old stdio backend; only recovery is exposed',async t=>{
  const f=await fixture(t);
  const client=new Client({name:'remote-codex-fixture',version:'1'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.url),{requestInit:{headers:{'x-caveman-gateway-key':key}}}));
  const list=await client.listTools();
  assert.deepEqual(list.tools.map(tool=>tool.name),['caveman_retrieve']);
  assert.deepEqual(list.tools[0].inputSchema.required,['recovery_handle']);
  const result=await client.callTool({name:'caveman_retrieve',arguments:{recovery_handle:'ccr_fixture',query:'find record'}});
  assert.deepEqual(JSON.parse(result.content[0].text),{handle:'ccr_fixture',query:'find record',extraKeys:[],authEnv:null});
  const exact=await client.callTool({name:'caveman_retrieve',arguments:{recovery_handle:'exact'}});
  assert.equal(exact.content[0].text,'원문\r\n  retained\tspaces\n');
});

test('only validated recovery arguments reach stdio; unknown handles retain tool errors',async t=>{
  const f=await fixture(t);
  const result=await f.post({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'caveman_compress',arguments:{input:'never forward'}}});
  assert.equal(result.body.error.code,-32602);
  for(const args of [{}, {recovery_handle:'x',query:8}, {recovery_handle:'x',filename:'/state/codex/auth.json'}]) {
    const invalid=await f.post({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'caveman_retrieve',arguments:args}});
    assert.equal(invalid.body.error.code,-32602);
  }
  const missing=await f.call('unknown');
  assert.equal(missing.body.result.isError,true);
  assert.match(missing.body.result.content[0].text,/cave_unknown_handle/);
  const auth=await f.post({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'caveman_retrieve',arguments:{recovery_handle:'own'}}},
    {authorization:'Bearer client-secret','chatgpt-account-id':'private-account'});
  assert.deepEqual(JSON.parse(auth.body.result.content[0].text),{handle:'own',query:null,extraKeys:[],authEnv:null});
  assert(!JSON.stringify(auth.body).includes('client-secret'));
});

test('stdio backend explicitly receives the offline and telemetry-disabled operating policy',async t=>{
  const f=await fixture(t);
  const result=await f.call('operating-environment');
  assert.deepEqual(JSON.parse(result.body.result.content[0].text),{offline:'1',telemetry:'0'});
});

test('concurrent clients can reuse JSON-RPC IDs without mixing recovery results',async t=>{
  const f=await fixture(t);
  const handles=['slow','other-1','other-2','other-3'];
  const results=await Promise.all(handles.map(handle=>f.call(handle)));
  assert.deepEqual(results.map(r=>JSON.parse(r.body.result.content[0].text).handle),handles);
  assert(results.every(r=>r.body.id===7));
});

test('backend exit and timeout fail clearly and next calls reconnect',async t=>{
  const f=await fixture(t,{timeoutMs:300});
  for(const handle of ['crash','hang']) {
    const failed=await f.call(handle);
    assert.equal(failed.body.result.isError,true);
    assert.match(failed.body.result.content[0].text,/cave_recovery_unavailable/);
    const recovered=await f.call('after-'+handle);
    assert.equal(JSON.parse(recovered.body.result.content[0].text).handle,'after-'+handle);
  }
});

test('missing executable returns a sanitized error',async t=>{
  const f=await fixture(t,{command:path.join(path.dirname(fixturePath),'private-secret-missing-executable')});
  const result=await f.call('x');
  assert.equal(result.body.result.isError,true);
  assert(!JSON.stringify(result.body).includes('private-secret'));
});

test('pending recovery calls are bounded without killing an admitted call',async t=>{
  const f=await fixture(t,{maxPending:1});
  // Warm the backend, then keep one call busy while another arrives.
  await f.call('warm');
  const slow=f.call('slow');
  await new Promise(resolve=>setTimeout(resolve,10));
  const busy=await f.call('overflow');
  assert.equal(busy.body.result.isError,true);
  assert.match(busy.body.result.content[0].text,/cave_recovery_busy/);
  assert.equal(JSON.parse((await slow).body.result.content[0].text).handle,'slow');
});

test('a disconnected HTTP client does not close the shared stdio backend',async t=>{
  const f=await fixture(t);
  const before=(await f.call('pid')).body.result.content[0].text;
  const controller=new AbortController();
  const abandoned=fetch(f.url,{method:'POST',headers,signal:controller.signal,body:JSON.stringify({
    jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'caveman_retrieve',arguments:{recovery_handle:'slow'}}
  })}).then(response=>response.text()).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,20));controller.abort();await abandoned;
  const after=(await f.call('pid')).body.result.content[0].text;
  assert.equal(after,before);
});

test('shutdown closes a child still waiting for its initialization response',async t=>{
  const f=await fixture(t,{env:{FIXTURE_INIT_MODE:'hang'},timeoutMs:5000});
  const request=f.call('waiting').catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,40));
  const start=Date.now();await f.gateway.closeRecovery();
  assert(Date.now()-start<2000,'shutdown waited for the initialization timeout');
  await request;
});

test('MCP bounds declared and streamed bodies and rejects invalid Origin or encoding',async t=>{
  const f=await fixture(t,{maxRequestBytes:256});
  for(const method of ['GET','DELETE']) {
    const response=await fetch(f.url,{method,headers});assert.equal(response.status,405);await response.text();
  }
  const badOrigin=await f.post({jsonrpc:'2.0',id:1,method:'ping'},{origin:'https://other.example'});
  assert.equal(badOrigin.status,403);
  const compressed=await f.post({}, {'content-encoding':'gzip'});assert.equal(compressed.status,415);
  const large=await f.post({text:'x'.repeat(300)});assert.equal(large.status,413);
  const streamed=await new Promise((resolve,reject)=>{
    const req=http.request(f.url,{method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.write(' '.repeat(200));req.end(' '.repeat(200));
  });
  assert.equal(streamed,413);
});
