import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,symlink} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {it,expect} from 'vitest';
import {provisioningHost,type ProvisioningHostRuntime} from './provisioning-host.js';
import type {ProvisioningCommand,ProvisioningRelease} from './provisioning-command.js';
const A={sourceRev:'a'.repeat(40),digest:'a'.repeat(64),closurePath:'/nix/store/'+'a'.repeat(32)+'-tower-app-a'};
const B={sourceRev:'b'.repeat(40),digest:'b'.repeat(64),closurePath:'/nix/store/'+'b'.repeat(32)+'-tower-app-b'};
const command=(r:ProvisioningRelease,baseline:ProvisioningRelease|null=null,operation:ProvisioningCommand['operation']='install'):ProvisioningCommand=>({schemaVersion:1,action:'start',instanceId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',attemptId:operation==='install'?'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb':'cccccccc-cccc-cccc-cccc-cccccccccccc',approvalHash:'d'.repeat(64),operation,baseline,release:r,mode:operation==='install'?'fresh-install':'nix-current'});
it('pins artifacts, initializes fresh DB, adopts/restarts and restores previous after failed update',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'provision-host-'));await chmod(root,0o700);const directory=path.join(root,'journal'),runtimeDirectory=path.join(root,'runtime'),environmentFile=path.join(root,'env');await mkdir(directory,{mode:0o700});await mkdir(runtimeDirectory,{mode:0o700});await writeFile(environmentFile,'NO_AUTH=false\n',{mode:0o600});
 let state='inactive',unit='',applied:string[]=[],failure=false,residualPid=false;const calls:string[]=[];
 const runtime:ProvisioningHostRuntime={verifySigned:async()=>{},pin:async(r,file)=>{await symlink(r.closurePath,file);},schema:async(_,m)=>{if(m==='apply'){applied=['001.sql'];calls.push('migrate');}return {applied:[...applied],pending:applied.length?[]:['001.sql']};},systemctl:async(a)=>{calls.push(a);if(a==='daemon-reload')unit=await readFile(path.join(directory,'units/tower-provision.service'),'utf8');if(a==='start')state='active';if(a==='stop')state='inactive';return `ActiveState=${state}\nMainPID=${state==='active'||residualPid?'1':'0'}\nControlPID=0\nControlGroup=\nExecStart=${unit.split('\n').find(l=>l.startsWith('ExecStart='))??''}\n`;},health:async()=>!failure};
 try{
  let host=await provisioningHost({directory,runtimeDirectory,environmentFile,unit:'tower-provision.service',user:'fixture',port:32365,cacheUrl:'https://cache.invalid',signingPublicKey:'fixture:'+Buffer.alloc(32).toString('base64')},runtime);
  const install=command(A);await host.start(install,async()=>{});expect((await host.observe(install) as {state:string}).state).toBe('active');await host.adopt({...install,action:'adopt'},async()=>{});expect(calls).toContain('migrate');
  const restart={...command(A,A,'restart'),attemptId:'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'};await host.start(restart,async()=>{});await host.adopt({...restart,action:'adopt'},async()=>{});expect(calls.filter(c=>c==='migrate')).toHaveLength(1);
  const update=command(B,A,'update');await host.start(update,async()=>{});residualPid=true;await expect(host.stopExact({...update,action:'stop'},async()=>{})).rejects.toThrow('readback_failed');residualPid=false;await runtime.systemctl('start','fixture');failure=true;expect((await host.observe(update) as {state:string}).state).toBe('failed');await host.stopExact({...update,action:'stop'},async()=>{});expect((await host.observe(update) as {state:string}).state).toBe('inactive');failure=false;await host.start({...update,release:A},async()=>{});expect((await host.observe(update) as {sourceRev:string}).sourceRev).toBe(A.sourceRev);
  await host.adopt({...update,action:'adopt',release:A},async()=>{});expect(JSON.parse(await readFile(path.join(directory,'current.json'),'utf8')).release.digest).toBe(A.digest);
  await expect(host.start(command(B,null),async()=>{})).rejects.toThrow('baseline_conflict');
  const starts=calls.filter(c=>c==='start').length;await expect(host.start({...command(B,A,'update'),attemptId:'ffffffff-ffff-ffff-ffff-ffffffffffff'},async()=>{throw Error('expired');})).rejects.toThrow('expired');expect(calls.filter(c=>c==='start')).toHaveLength(starts);
  host=await provisioningHost({directory,runtimeDirectory,environmentFile,unit:'tower-provision.service',user:'fixture',port:32365,cacheUrl:'https://cache.invalid',signingPublicKey:'fixture:'+Buffer.alloc(32).toString('base64')},runtime);expect((await host.observe(update) as {state:string}).state).toBe('active');
 }finally{await rm(root,{recursive:true,force:true});}
});
