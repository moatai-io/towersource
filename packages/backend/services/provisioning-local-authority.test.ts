import {mkdtemp,mkdir,rm,readFile,readdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {generateKeyPairSync,sign} from 'node:crypto';
import {it,expect} from 'vitest';
import {localProvisioningAuthority,provisioningCommandHash} from './provisioning-local-authority.js';
import {handleProvisioningCommand,type ProvisioningCommand,type ProvisioningHost} from './provisioning-command.js';
const c:ProvisioningCommand={schemaVersion:1,action:'start',instanceId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',attemptId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',approvalHash:'c'.repeat(64),operation:'install' as const,baseline:null,mode:'fresh-install',release:{sourceRev:'a'.repeat(40),digest:'b'.repeat(64),closurePath:'/nix/store/'+'a'.repeat(32)+'-tower-app-1'}};
const principal={subject:'fixture',instanceId:c.instanceId};
async function fixture(run:(root:string,make:(expires?:number)=>ReturnType<typeof localProvisioningAuthority>)=>Promise<void>){const root=await mkdtemp(path.join(tmpdir(),'provision-local-'));await chmod(root,0o700);const {publicKey,privateKey}=generateKeyPairSync('ed25519');const make=(expires=Date.now()+60000)=>{const payload=JSON.stringify({version:1,...principal,attemptId:c.attemptId,approvalHash:c.approvalHash,expiresAt:new Date(expires).toISOString(),commandHashes:[provisioningCommandHash(c)]});return localProvisioningAuthority({directory:root,publicKey,approval:{payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')}});};try{await run(root,make);}finally{await rm(root,{recursive:true,force:true});}}
function host(counter:{starts:number},fail=false):ProvisioningHost{return {verify:async()=>{},start:async()=>{counter.starts++;if(fail)throw Error('synthetic');return 'fixture';},stopExact:async()=> 'fixture',adopt:async()=> 'fixture',observe:async()=>({})};}
it('fsynced intent and accepted journal persist across authority recreation; replay blocked',async()=>fixture(async(root,make)=>{const count={starts:0};await handleProvisioningCommand(c,principal,await make(),host(count));await expect(handleProvisioningCommand(c,principal,await make(),host(count))).rejects.toThrow();expect(count.starts).toBe(1);const file=(await readdir(root)).find(n=>n.endsWith('.json'))!;expect(JSON.parse(await readFile(path.join(root,file),'utf8')).state).toBe('accepted');}));
it('ambiguous start is preserved and never replayed',async()=>fixture(async(root,make)=>{const count={starts:0};await expect(handleProvisioningCommand(c,principal,await make(),host(count,true))).rejects.toThrow('reconciliation_required');const file=(await readdir(root)).find(n=>n.endsWith('.json'))!;expect(JSON.parse(await readFile(path.join(root,file),'utf8')).state).toBe('reconciliation_required');await expect(handleProvisioningCommand(c,principal,await make(),host(count))).rejects.toThrow();expect(count.starts).toBe(1);}));
it('expired approval, changed release and stale lock reject before host start',async()=>fixture(async(root,make)=>{const count={starts:0};await expect(handleProvisioningCommand(c,principal,await make(Date.now()-1000),host(count))).rejects.toThrow('denied');await expect(handleProvisioningCommand({...c,release:{...c.release!,sourceRev:'d'.repeat(40)}},principal,await make(),host(count))).rejects.toThrow('denied');await mkdir(path.join(root,'instance.lock'));await expect(handleProvisioningCommand(c,principal,await make(),host(count))).rejects.toThrow();expect(count.starts).toBe(0);}));
it('canonical hash does not depend on incoming JSON field order',()=>{const {release,...base}=c;expect(provisioningCommandHash({...base,release:{closurePath:release!.closurePath,digest:release!.digest,sourceRev:release!.sourceRev}})).toBe(provisioningCommandHash(c));});

it('untrusted signature and permissive journal permissions are rejected',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'provision-trust-'));
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const other=generateKeyPairSync('ed25519');
 const payload=JSON.stringify({version:1,...principal,attemptId:c.attemptId,approvalHash:c.approvalHash,expiresAt:new Date(Date.now()+60000).toISOString(),commandHashes:[provisioningCommandHash(c)]});
 try{
  await chmod(root,0o700);
  await expect(localProvisioningAuthority({directory:root,publicKey,approval:{payload,signature:sign(null,Buffer.from(payload),other.privateKey).toString('base64')}})).rejects.toThrow('signature_invalid');
  await chmod(root,0o755);
  await expect(localProvisioningAuthority({directory:root,publicKey,approval:{payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')}})).rejects.toThrow('directory_invalid');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('an ambiguous earlier attempt blocks a new signed mutation while observe remains available',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'provision-unresolved-'));await chmod(root,0o700);const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const approval=async(cmd:ProvisioningCommand)=>{const payload=JSON.stringify({version:1,...principal,attemptId:cmd.attemptId,approvalHash:cmd.approvalHash,expiresAt:new Date(Date.now()+60000).toISOString(),commandHashes:[provisioningCommandHash(cmd)]});return localProvisioningAuthority({directory:root,publicKey,approval:{payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')}});};
 try{const count={starts:0};await expect(handleProvisioningCommand(c,principal,await approval(c),host(count,true))).rejects.toThrow('reconciliation_required');
  const next={...c,attemptId:'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'};await expect(handleProvisioningCommand(next,principal,await approval(next),host(count))).rejects.toThrow('unresolved_host_attempt');expect(count.starts).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});
