import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {once} from 'node:events';
import {createCallbackRelay,runOAuthLogin} from '../scripts/codex-oauth-login.mjs';

async function unusedPort() {
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function portIsClosed(port) {
  await assert.rejects(new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});
    socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);
  }),{code:'ECONNREFUSED'});
}

test('OAuth callback relay preserves the request and response without logging callback credentials',async t=>{
  let seen;
  const callback=http.createServer((req,res)=>{seen={url:req.url,host:req.headers.host};res.setHeader('location','/success');res.end('login callback accepted');});
  callback.listen(0,'127.0.0.1');await once(callback,'listening');
  t.after(()=>new Promise(resolve=>callback.close(resolve)));
  const relay=await createCallbackRelay({host:'127.0.0.1',port:0,targetPort:callback.address().port});
  t.after(()=>relay.close());
  const response=await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port:relay.port,path:'/auth/callback?code=fake-one-time-code&state=fake-state',headers:{Host:'localhost:1455'}},res=>{
      let data='';res.on('data',chunk=>{data+=chunk;});res.on('end',()=>resolve({data,location:res.headers.location,status:res.statusCode}));
    }).on('error',reject);
  });
  assert.deepEqual(seen,{url:'/auth/callback?code=fake-one-time-code&state=fake-state',host:'localhost:1455'});
  assert.deepEqual(response,{data:'login callback accepted',location:'/success',status:200});
});

test('relay shutdown closes idle clients and releases the listener',async()=>{
  const upstream=net.createServer();upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  let peer;upstream.once('connection',socket=>{peer=socket;});
  const relay=await createCallbackRelay({host:'127.0.0.1',port:0,targetPort:upstream.address().port});
  const client=net.connect(relay.port,'127.0.0.1');await once(client,'connect');
  const closed=once(client,'close');
  await relay.close();await closed;await portIsClosed(relay.port);
  peer?.destroy();await new Promise(resolve=>upstream.close(resolve));
});

test('login child exit status is preserved and callback port is closed',async()=>{
  const port=await unusedPort();
  assert.equal(await runOAuthLogin({command:process.execPath,args:['-e','process.exit(7)'],relay:{host:'127.0.0.1',port},timeoutMs:5000}),7);
  await portIsClosed(port);
});

test('occupied relay refuses login before spawning any child',async()=>{
  const occupied=net.createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
  let spawned=false;
  try {
    await assert.rejects(runOAuthLogin({relay:{host:'127.0.0.1',port:occupied.address().port},spawnFn:()=>{spawned=true;}}),{code:'EADDRINUSE'});
    assert.equal(spawned,false);
  } finally { await new Promise(resolve=>occupied.close(resolve)); }
});

test('failed executable releases relay instead of leaving an OAuth port open',async()=>{
  const port=await unusedPort();
  await assert.rejects(runOAuthLogin({command:'missing-oauth-test-executable',relay:{host:'127.0.0.1',port}}),{code:'ENOENT'});
  await portIsClosed(port);
});

test('interrupt stops the login process and cleans up signal listeners and callback sockets',async()=>{
  const signals=new EventEmitter(),port=await unusedPort();let child;
  const result=runOAuthLogin({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],relay:{host:'127.0.0.1',port},signalSource:signals,
    spawnFn:(...args)=>{child=spawn(...args);child.once('spawn',()=>signals.emit('SIGINT'));return child;}});
  assert.equal(await result,130);
  assert.ok(child.exitCode!==null||child.signalCode!==null);
  assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);
  await portIsClosed(port);
});

test('abandoned login expires and cannot leave the callback relay listening',async()=>{
  const port=await unusedPort();let child;
  const result=await runOAuthLogin({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],relay:{host:'127.0.0.1',port},timeoutMs:50,
    spawnFn:(...args)=>{child=spawn(...args);return child;}});
  assert.equal(result,124);assert.ok(child.exitCode!==null||child.signalCode!==null);
  await portIsClosed(port);
});

test('a login ignoring termination is killed after the grace period',{skip:process.platform==='win32'},async()=>{
  const signals=new EventEmitter(),port=await unusedPort();let child;
  const result=await runOAuthLogin({command:process.execPath,
    args:['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"],
    relay:{host:'127.0.0.1',port},signalSource:signals,timeoutMs:5000,graceMs:50,
    spawnFn:(command,args,options)=>{
      child=spawn(command,args,{...options,stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>signals.emit('SIGTERM'));return child;
    }});
  assert.equal(result,143);assert.equal(child.signalCode,'SIGKILL');await portIsClosed(port);
});
