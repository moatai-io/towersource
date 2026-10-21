import {createHash,createPublicKey,verify,type KeyObject} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,realpath,mkdir,open,rename,rmdir,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import type {ProvisioningCommand,ProvisioningCommandAuthority,ProvisioningPrincipal} from './provisioning-command.js';

export function provisioningCommandHash(c:Readonly<ProvisioningCommand>):string {
 // Canonical projection: property insertion order of incoming JSON is irrelevant.
 const value={schemaVersion:c.schemaVersion,action:c.action,instanceId:c.instanceId,attemptId:c.attemptId,approvalHash:c.approvalHash,release:c.release?{sourceRev:c.release.sourceRev,digest:c.release.digest,closurePath:c.release.closurePath}:null,mode:c.mode??null,operation:c.operation,baseline:c.baseline?{sourceRev:c.baseline.sourceRev,digest:c.baseline.digest,closurePath:c.baseline.closurePath}:null};
 return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export interface LocalApproval {version:1;subject:string;instanceId:string;attemptId:string;approvalHash:string;expiresAt:string;commandHashes:string[];}
export interface LocalApprovalEnvelope {payload:string;signature:string;}
/** The trust key must be installed by the operator; never derive it from the request. */
export async function localProvisioningAuthority(options:{directory:string;publicKey:KeyObject|string;approval:LocalApprovalEnvelope;now?:()=>number}):Promise<ProvisioningCommandAuthority>{
 const dir=options.directory;
 if(!path.isAbsolute(dir)||await realpath(dir)!==dir)throw Error('provisioning_journal_directory_invalid');
 const st=await lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw Error('provisioning_journal_directory_invalid');
 const key=typeof options.publicKey==='string'?createPublicKey(options.publicKey):options.publicKey;
 if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')throw Error('provisioning_trust_key_invalid');
 const envelope=Object.freeze({...options.approval});
 if(Buffer.byteLength(envelope.payload)>16384||!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)||!verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,'base64')))throw Error('provisioning_approval_signature_invalid');
 const raw:unknown=JSON.parse(envelope.payload);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('provisioning_approval_invalid');
 const a=raw as LocalApproval;
 const keys=['version','subject','instanceId','attemptId','approvalHash','expiresAt','commandHashes'];
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 if(Object.keys(a).length!==keys.length||!keys.every(k=>Object.hasOwn(a,k))||a.version!==1||typeof a.subject!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(a.subject)||!uuid.test(a.instanceId)||!uuid.test(a.attemptId)||!/^[a-f0-9]{64}$/.test(a.approvalHash)||typeof a.expiresAt!=='string'||!Number.isFinite(Date.parse(a.expiresAt))||!Array.isArray(a.commandHashes)||a.commandHashes.length<1||a.commandHashes.length>32||!a.commandHashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||new Set(a.commandHashes).size!==a.commandHashes.length)throw Error('provisioning_approval_invalid');
 const approval=Object.freeze({...a,commandHashes:Object.freeze([...a.commandHashes])});
 const now=options.now??Date.now;
 let lockedCommand:string|undefined;
 async function syncDir(){const f=await open(dir,'r');try{await f.sync();}finally{await f.close();}}
 async function persist(file:string,value:unknown,exclusive:boolean){
  const temp=exclusive?file:file+'.pending';
  const f=await open(temp,'wx',0o600);
  try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();}finally{await f.close();}
  if(!exclusive)await rename(temp,file);
  await syncDir();
 }
 const hash=provisioningCommandHash;
 function check(c:Readonly<ProvisioningCommand>){
  if(now()>=Date.parse(approval.expiresAt)||c.instanceId!==approval.instanceId||c.attemptId!==approval.attemptId||c.approvalHash!==approval.approvalHash||!approval.commandHashes.includes(hash(c)))throw Error('provisioning_command_denied');
 }
 function underLock(c:Readonly<ProvisioningCommand>){check(c);if(lockedCommand!==hash(c))throw Error('provisioning_host_lock_required');}
 async function rejectUnresolved(){
  const files=await readdir(dir);if(files.length>10000)throw Error('provisioning_journal_limit');
  for(const name of files){
   if(!/^[a-f0-9]{64}\.json(?:\.pending)?$/.test(name))continue;
   if(name.endsWith('.pending'))throw Error('provisioning_unresolved_host_attempt');
   const f=await open(path.join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const st=await f.stat();if(!st.isFile()||st.size>4096||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('provisioning_journal_invalid');
    const record=JSON.parse((await f.readFile()).toString('utf8'));
    if(record.version!==1||record.commandHash!==name.slice(0,64)||record.instanceId!==approval.instanceId||!['accepted','intent','reconciliation_required'].includes(record.state))throw Error('provisioning_journal_invalid');
    if(record.state!=='accepted')throw Error('provisioning_unresolved_host_attempt');
   }finally{await f.close();}
  }
 }
 const journal=(c:Readonly<ProvisioningCommand>)=>path.join(dir,hash(c)+'.json');
 async function transition(c:Readonly<ProvisioningCommand>,state:string,evidenceId?:string){
  underLock(c);const filename=journal(c);const record=JSON.parse(await readFile(filename,'utf8'));
  if(record.commandHash!==hash(c)||record.state!=='intent')throw Error('provisioning_journal_transition_invalid');
  await persist(filename,{...record,state,...(evidenceId?{evidenceId}:{}),updatedAt:new Date(now()).toISOString()},false);
 }
 return {
  async authorize(p:ProvisioningPrincipal,c){check(c);if(p.subject!==approval.subject||p.instanceId!==approval.instanceId)throw Error('provisioning_command_denied');},
  async locked(c,run){
   check(c);if(lockedCommand)throw Error('provisioning_host_busy');
   // Instance-wide lock: never automatically reclaim a crashed process's lock.
   const lock=path.join(dir,'instance.lock');await mkdir(lock,{mode:0o700});
   lockedCommand=hash(c);
   try{await syncDir();return await run();}finally{lockedCommand=undefined;await rmdir(lock);await syncDir();}
  },
  async prepare(c){underLock(c);await rejectUnresolved();await persist(journal(c),{version:1,commandHash:hash(c),instanceId:c.instanceId,attemptId:c.attemptId,action:c.action,state:'intent',createdAt:new Date(now()).toISOString()},true);},
  async finish(c,id){if(!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw Error('provisioning_evidence_invalid');await transition(c,'accepted',id);},
  async uncertain(c){await transition(c,'reconciliation_required');},
 };
}
