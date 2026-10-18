import net from 'node:net';
// Include upstream readiness, not only the public gateway listener.
await Promise.all([8080,8787,10101].map(port=>new Promise((resolve,reject)=>{
  const s=net.connect(port,'127.0.0.1',()=>{s.end();resolve();});
  s.setTimeout(3000,()=>{s.destroy();reject(Error('Readiness timeout'));});
  s.on('error',reject);
}))).catch(()=>process.exit(1));
