/** Instance-side provisioning command. No HTTP route and no Fleet delegation. */
export interface ProvisioningRelease {sourceRev:string;digest:string;closurePath:string;}
export interface ProvisioningCommand {schemaVersion:1;action:'start'|'stop'|'observe'|'adopt';instanceId:string;attemptId:string;approvalHash:string;operation:'install'|'restart'|'update';baseline:ProvisioningRelease|null;release?:ProvisioningRelease;mode?:'fresh-install'|'nix-current';}
export interface ProvisioningPrincipal {subject:string;instanceId:string;}
export interface ProvisioningCommandAuthority {
 authorize(principal:ProvisioningPrincipal,command:Readonly<ProvisioningCommand>):Promise<void>;
 locked<T>(command:Readonly<ProvisioningCommand>,run:()=>Promise<T>):Promise<T>;
 prepare(command:Readonly<ProvisioningCommand>):Promise<void>;
 finish(command:Readonly<ProvisioningCommand>,evidenceId:string):Promise<void>;
 uncertain(command:Readonly<ProvisioningCommand>):Promise<void>;
}
export interface ProvisioningHost {
 verify(release:Readonly<ProvisioningRelease>):Promise<void>;
 start(command:Readonly<ProvisioningCommand>,fence:()=>Promise<void>):Promise<string>;
 stopExact(command:Readonly<ProvisioningCommand>,fence:()=>Promise<void>):Promise<string>;
 adopt(command:Readonly<ProvisioningCommand>,fence:()=>Promise<void>):Promise<string>;
 observe(command:Readonly<ProvisioningCommand>):Promise<unknown>;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function object(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function release(v:unknown):v is ProvisioningRelease{return object(v,['sourceRev','digest','closurePath'])&&typeof v.sourceRev==='string'&&/^[a-f0-9]{40}$/.test(v.sourceRev)&&typeof v.digest==='string'&&/^[a-f0-9]{64}$/.test(v.digest)&&typeof v.closurePath==='string'&&/^\/nix\/store\/[0123456789abcdfghijklmnpqrsvwxyz]{32}-tower-app-[A-Za-z0-9.+_-]+$/.test(v.closurePath);}
export function parseProvisioningCommand(v:unknown):Readonly<ProvisioningCommand>{
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('provisioning_command_invalid');
 const d=v as Record<string,unknown>,action=d.action;
 const keys=['schemaVersion','action','instanceId','attemptId','approvalHash','operation','baseline',...(action==='start'?['release','mode']:action==='stop'||action==='adopt'?['release']:[])];
 if(!object(d,keys)||d.schemaVersion!==1||!['start','stop','observe','adopt'].includes(action as string)||typeof d.instanceId!=='string'||!uuid.test(d.instanceId)||typeof d.attemptId!=='string'||!uuid.test(d.attemptId)||typeof d.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(d.approvalHash)||!['install','restart','update'].includes(d.operation as string)||!(d.baseline===null||release(d.baseline))||(d.operation==='install')!==(d.baseline===null))throw Error('provisioning_command_invalid');
 if(action!=='observe'&&(!release(d.release)||(action==='start'&&!['fresh-install','nix-current'].includes(d.mode as string))))throw Error('provisioning_command_invalid');
 if(action==='start'&&(d.operation==='install')!==(d.mode==='fresh-install'))throw Error('provisioning_command_invalid');
 const copy=(r:ProvisioningRelease)=>Object.freeze({sourceRev:r.sourceRev,digest:r.digest,closurePath:r.closurePath});
 return Object.freeze({...d,baseline:d.baseline===null?null:copy(d.baseline as ProvisioningRelease),...(d.release?{release:copy(d.release as ProvisioningRelease)}:{})}) as unknown as Readonly<ProvisioningCommand>;
}
function observation(v:unknown,c:Readonly<ProvisioningCommand>){
 if(!object(v,['instanceId','attemptId','sourceRev','digest','state','evidenceId'])||v.instanceId!==c.instanceId||v.attemptId!==c.attemptId||typeof v.sourceRev!=='string'||!/^[a-f0-9]{40}$/.test(v.sourceRev)||typeof v.digest!=='string'||!/^[a-f0-9]{64}$/.test(v.digest)||!['active','inactive','failed','unknown'].includes(v.state as string)||typeof v.evidenceId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(v.evidenceId))throw Error('provisioning_observation_invalid');
 return Object.freeze({...v});
}
export async function handleProvisioningCommand(input:unknown,inputPrincipal:ProvisioningPrincipal,authority:ProvisioningCommandAuthority,host:ProvisioningHost):Promise<unknown>{
 const c=parseProvisioningCommand(input),principal=Object.freeze({...inputPrincipal});
 if(!principal.subject||principal.instanceId!==c.instanceId)throw Error('provisioning_command_denied');
 await authority.authorize(principal,c);
 return authority.locked(c,async()=>{
  await authority.authorize(principal,c);
  if(c.action==='observe')return observation(await host.observe(c),c);
  if(c.action==='start'||c.action==='adopt')await host.verify(c.release!);
  await authority.prepare(c);
  try{
   const fence=()=>authority.authorize(principal,c);
   const evidenceId=c.action==='start'?await host.start(c,fence):c.action==='stop'?await host.stopExact(c,fence):await host.adopt(c,fence);
   if(!/^[A-Za-z0-9_-]{1,120}$/.test(evidenceId))throw Error('provisioning_evidence_invalid');
   await authority.finish(c,evidenceId);
   return {schemaVersion:1,action:c.action,instanceId:c.instanceId,attemptId:c.attemptId,sourceRev:c.release!.sourceRev,digest:c.release!.digest,status:'accepted',evidenceId};
  }catch{
   try{await authority.uncertain(c);}catch{throw Error('provisioning_reconciliation_persistence_unknown');}
   throw Error('provisioning_command_reconciliation_required');
  }
 });
}
