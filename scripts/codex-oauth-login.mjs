// Temporary callback relay for Codex's loopback-only browser OAuth listener.
// The host publishes 127.0.0.1:1455 -> container1456; Codex still uses1455.
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export async function createCallbackRelay({host='0.0.0.0',port=1456,targetPort=1455}={}) {
  const sockets=new Set();
  const track=socket=>{
    sockets.add(socket);
    socket.setTimeout(60000,()=>socket.destroy());
    socket.on('close',()=>sockets.delete(socket));
    return socket;
  };
  const server=net.createServer(incoming=>{
    track(incoming);
    const upstream=track(net.connect({host:'127.0.0.1',port:targetPort}));
    incoming.on('error',()=>upstream.destroy());
    upstream.on('error',()=>incoming.destroy());
    incoming.on('close',()=>upstream.destroy());
    upstream.on('close',()=>incoming.destroy());
    incoming.pipe(upstream).pipe(incoming);
  });
  server.maxConnections=32;
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});
  });
  return {
    port:server.address().port,
    close:()=>new Promise(resolve=>{
      for(const socket of sockets)socket.destroy();
      server.close(()=>resolve());
    })
  };
}

export async function runOAuthLogin({command='/app/node_modules/.bin/codex',args=['login'],
  relay={},timeoutMs=15*60*1000,graceMs=2000,signalSource=process,spawnFn=spawn}={}) {
  const callback=await createCallbackRelay(relay);
  let child,timer,killTimer,requestedCode;
  const signals=new Map();
  const kill=signal=>{
    if(!child?.pid)return;
    try {
      // Codex's npm launcher starts the native binary. Signal the whole group.
      if(process.platform!=='win32')process.kill(-child.pid,signal);
      else child.kill(signal);
    } catch(error) { if(error.code!=='ESRCH')throw error; }
  };
  const stop=(signal,code)=>{
    if(requestedCode!==undefined)return;
    requestedCode=code;
    kill(signal);
    killTimer=setTimeout(()=>kill('SIGKILL'),graceMs);
    killTimer.unref();
  };
  try {
    child=spawnFn(command,args,{stdio:'inherit',env:process.env,detached:process.platform!=='win32'});
    const completion=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',(code,signal)=>resolve(requestedCode??code??({SIGINT:130,SIGTERM:143,SIGHUP:129}[signal]??1)));
    });
    for(const [signal,code] of Object.entries({SIGINT:130,SIGTERM:143,SIGHUP:129})) {
      const handler=()=>stop(signal,code);
      signals.set(signal,handler);signalSource.on(signal,handler);
    }
    timer=setTimeout(()=>stop('SIGTERM',124),timeoutMs);
    timer.unref();
    return await completion;
  } finally {
    // The npm launcher may exit before a native child that ignored termination.
    // Its private process group belongs to this one login invocation.
    kill('SIGKILL');
    clearTimeout(timer);clearTimeout(killTimer);
    for(const [signal,handler] of signals)signalSource.removeListener(signal,handler);
    await callback.close();
  }
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try { process.exitCode=await runOAuthLogin({args:process.argv.slice(2)}); }
  catch { console.error('Browser OAuth login could not start. Check that no other login owns container ports1455/1456.');process.exitCode=1; }
}
