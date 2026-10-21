import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { createWorkstationLaunchServer, executeWorkstationLaunch } from './workstation-launch-transport.js';
import { createWorkstationLaunchDispatcher } from './workstation-launch-dispatch.js';
import { createWorkstationLaunchVerifier, signWorkstationLaunch } from './workstation-launch-authorization.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-launch-ipc-'));
 cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
 const keys = generateKeyPairSync('ed25519'); let sequence = 0;
 const uid = process.getuid!(), gid = process.getgid!();
 const credential = path.join(root, 'input');
 let cleaned = 0;
 const dispatch = createWorkstationLaunchDispatcher({
  policy: { projectId: 'p', uid, gid, home: root, projectRoot: root },
  controllerUid: uid + 1, identity: () => ({ uid, gid, groups: [gid] }), // plumbing only
  verify: createWorkstationLaunchVerifier({ publicKey: keys.publicKey, projectId: 'p', instanceId: 'instance' }),
  prepare: async credentials => {
   await fs.writeFile(credential, credentials.DEMO, { mode: 0o600 });
   return { env: { INPUT: credential }, cleanup: async () => { await fs.unlink(credential); cleaned++; } };
  },
  run: input => new Promise<string>((resolve, reject) => {
   execFile('/bin/sh', ['-c', input.command], { cwd: input.cwd, env: { HOME: input.home, ...input.env }, signal: input.signal, timeout: input.timeoutSec * 1000, maxBuffer: 4096 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
 });
 const service = createWorkstationLaunchServer(dispatch);
 const socket = path.join(root, 'launch.sock');
 await new Promise<void>(resolve => service.server.listen(socket, resolve));
 cleanups.push(service.close);
 const request = (command: string) => signWorkstationLaunch({ version: 1, instanceId: 'instance', projectId: 'p', requestId: `r${++sequence}`, issuedAt: Date.now(), expiresAt: Date.now()+30000,
 payload: JSON.stringify({ command, cwd: '.', timeoutSec: 2, credentials: { DEMO: 'synthetic' } }) }, keys.privateKey);
 return { root, socket, request, credential, cleaned: () => cleaned };
}
it('executes signed dispatch through real IPC and returns only after cleanup', async () => {
 const f = await fixture(); const request = f.request('test -r "$INPUT" && printf retained > output && printf ok');
 expect(await executeWorkstationLaunch(f.socket, request, new AbortController().signal)).toBe('ok');
 expect(await fs.readFile(path.join(f.root, 'output'), 'utf8')).toBe('retained');
 await expect(fs.stat(f.credential)).rejects.toMatchObject({code:'ENOENT'});
 await expect(executeWorkstationLaunch(f.socket, request, new AbortController().signal)).rejects.toThrow('ALREADY_CONSUMED');
 expect(f.cleaned()).toBe(1);
});
it('propagates disconnect cancellation to a real child and eventually cleans', async () => {
 const f = await fixture(); const abort = new AbortController();
 const result = executeWorkstationLaunch(f.socket, f.request('exec /bin/sleep 10'), abort.signal);
 const assertion = expect(result).rejects.toThrow('CANCELLED');
 for (let i=0; i<100; i++) { if (await fs.stat(f.credential).then(()=>true,()=>false)) break; await new Promise(r=>setTimeout(r,10)); }
 abort.abort(); await assertion;
 for (let i=0; i<100 && !f.cleaned(); i++) await new Promise(r=>setTimeout(r,10));
 expect(f.cleaned()).toBe(1);
});
it('rejects tampering before preparation and preserves sanitized execution errors', async () => {
 const f = await fixture(); const request = f.request('true');
 await expect(executeWorkstationLaunch(f.socket, {...request, wire: request.wire.replace('true','false')}, new AbortController().signal)).rejects.toThrow('SIGNATURE_INVALID');
 expect(f.cleaned()).toBe(0);
 await expect(executeWorkstationLaunch(f.socket, f.request('exit 3'), new AbortController().signal)).rejects.toThrow('EXECUTION_FAILED');
 expect(f.cleaned()).toBe(1);
});

it('redacts code-shaped arbitrary errors', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-error-'));
 cleanups.push(() => fs.rm(root,{recursive:true,force:true}));
 const s = createWorkstationLaunchServer(async () => { throw new Error('LAUNCH_SECRET_VALUE'); });
 const socket = path.join(root,'s'); await new Promise<void>(r=>s.server.listen(socket,r)); cleanups.push(s.close);
 await expect(executeWorkstationLaunch(socket,{wire:'x',signature:'x'},new AbortController().signal)).rejects.toThrow(/^LAUNCH_DISPATCH_FAILED$/);
});

it('bounds connection and dispatch capacity and waits for cleanup on close', async () => {
 const net = await import('node:net');
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'tower-cap-')); cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
 let cleaned=false, started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const s=createWorkstationLaunchServer(async (_r,signal)=>{started();await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));cleaned=true;return 'done';},{maxConnections:2,maxDispatches:1});
 const socket=path.join(root,'s');await new Promise<void>(r=>s.server.listen(socket,r));cleanups.push(s.close);
 const first=net.createConnection(socket);first.on('error',()=>{});first.write('{"wire":"x","signature":"x"}\n');await ready;
 await expect(executeWorkstationLaunch(socket,{wire:'x',signature:'x'},new AbortController().signal)).rejects.toThrow('CAPACITY_EXCEEDED');
 await s.close();expect(cleaned).toBe(true);
});
it('rejects invalid and extra request frames before dispatch', async () => {
 const net=await import('node:net');const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-frame-'));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
 let calls=0;const s=createWorkstationLaunchServer(async()=>{calls++;return 'ok';});const socket=path.join(root,'s');await new Promise<void>(r=>s.server.listen(socket,r));cleanups.push(s.close);
 for(const data of ['invalid\n','{"wire":"x","signature":"x"}\nextra\n','x'.repeat(2*1024*1024+1)]){
  await new Promise<void>(resolve=>{const c=net.createConnection(socket);c.on('error',()=>{});c.on('data',()=>{});c.on('close',()=>resolve());c.on('connect',()=>c.write(data));});
 }
 expect(calls).toBe(0);
});
it('applies absolute frame and client deadlines despite drip activity', async () => {
 const net=await import('node:net');const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-slow-'));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
 const s=createWorkstationLaunchServer(async()=>{throw new Error('not reached');},{frameDeadlineMs:100});const socket=path.join(root,'s');await new Promise<void>(r=>s.server.listen(socket,r));cleanups.push(s.close);
 await new Promise<void>(resolve=>{const c=net.createConnection(socket);const drip=setInterval(()=>c.write(' '),10);c.on('error',()=>{});c.on('close',()=>{clearInterval(drip);resolve();});});
 const fake=net.createServer(c=>{c.on('error',()=>{});const drip=setInterval(()=>c.write(' '),10);c.on('close',()=>clearInterval(drip));});const p=path.join(root,'fake');await new Promise<void>(r=>fake.listen(p,r));
 try{await expect(executeWorkstationLaunch(p,{wire:'x',signature:'x'},new AbortController().signal,100)).rejects.toThrow('TIMEOUT');}finally{await new Promise<void>(r=>fake.close(()=>r()));}
});
it('rejects a delayed trailing response frame', async()=>{
 const net=await import('node:net');const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-response-'));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
 const s=net.createServer(c=>{c.resume();c.on('error',()=>{});c.write('{"ok":true,"result":"ok"}\n');setImmediate(()=>c.end('extra\n'));});const p=path.join(root,'s');await new Promise<void>(r=>s.listen(p,r));
 try{await expect(executeWorkstationLaunch(p,{wire:'x',signature:'x'},new AbortController().signal)).rejects.toThrow('RESPONSE_INVALID');}finally{await new Promise<void>(r=>s.close(()=>r()));}
});
