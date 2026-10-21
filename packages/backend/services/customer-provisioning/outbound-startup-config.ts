import fs from 'node:fs';import {execFileSync} from 'node:child_process';import path from 'node:path';
import type {InstalledOutboundApproval} from './outbound-local-approval.js';
export interface OutboundStartupConfig {schemaVersion:1;expiresAt:string;baseUrl:string;credentialFile:string;bootstrapTokenFile:string;customerId:string;deliveryPolicyFiles:{zuplo:string;litellm:string};aiIntentId:string;installed:InstalledOutboundApproval;}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw Error('outbound_startup_shape');}
export function parseOutboundStartupConfig(raw:any,instanceId:string|undefined,now=Date.now()):OutboundStartupConfig{
 exact(raw,['schemaVersion','expiresAt','baseUrl','credentialFile','bootstrapTokenFile','customerId','deliveryPolicyFiles','aiIntentId','installed']);
 if(raw.schemaVersion!==1||typeof raw.expiresAt!=='string'||!Number.isFinite(Date.parse(raw.expiresAt))||Date.parse(raw.expiresAt)<=now||!uuid(raw.aiIntentId)||typeof raw.customerId!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(raw.customerId)||typeof raw.credentialFile!=='string'||!path.isAbsolute(raw.credentialFile)||raw.credentialFile.split('/').includes('..'))throw Error('outbound_startup_invalid');
 exact(raw.deliveryPolicyFiles,['zuplo','litellm']);for(const file of Object.values(raw.deliveryPolicyFiles))if(typeof file!=='string'||!path.isAbsolute(file)||file.split('/').includes('..'))throw Error('outbound_startup_policy_path');
 if(typeof raw.bootstrapTokenFile!=='string'||!path.isAbsolute(raw.bootstrapTokenFile)||raw.bootstrapTokenFile.split('/').includes('..')||raw.bootstrapTokenFile===raw.credentialFile)throw Error('outbound_bootstrap_path');
 const url=new URL(raw.baseUrl);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.hash||url.search)throw Error('outbound_startup_endpoint_invalid');
 const a=raw.installed;exact(a,['organizationId','instanceId','executionId','approvalHash','deliveries']);
 if(!uuid(a.organizationId)||!uuid(a.instanceId)||a.instanceId!==instanceId||!uuid(a.executionId)||typeof a.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(a.approvalHash)||!Array.isArray(a.deliveries)||a.deliveries.length!==2)throw Error('outbound_startup_identity_invalid');
 for(const d of a.deliveries){exact(d,['deliveryId','intentId','provider','policyHash','credentialId']);if(!uuid(d.deliveryId)||!uuid(d.intentId)||!['zuplo','litellm'].includes(d.provider)||typeof d.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(d.policyHash)||typeof d.credentialId!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(d.credentialId))throw Error('outbound_startup_delivery_invalid');}
 for(const key of ['deliveryId','intentId','provider','credentialId'])if(new Set(a.deliveries.map((d:any)=>d[key])).size!==2)throw Error('outbound_startup_duplicate');
 if(a.deliveries.some((d:any)=>d.intentId===raw.aiIntentId))throw Error('outbound_startup_duplicate');
 return structuredClone(raw);
}
/** Root installation only; never writes or discovers credentials. */
function readProtected(file:string,max:number){
 if(!path.isAbsolute(file)||file.split('/').includes('..'))throw Error('outbound_startup_path');
 for(let p=path.dirname(file);;p=path.dirname(p)){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw Error('outbound_startup_parent');if(p===path.dirname(p))break;}
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||![0o600,0o640].includes(s.mode&0o777)||s.size<1||s.size>max)throw Error('outbound_startup_file');const b=Buffer.alloc(s.size);let n=0;while(n<b.length){const count=fs.readSync(fd,b,n,b.length-n,null);if(!count)throw Error('outbound_startup_short_read');n+=count;}return b;}finally{fs.closeSync(fd);}
}
export function systemdAcl(file:string,uid:number,directory:boolean){
 if(!/^\/run\/credentials\/[A-Za-z0-9_.@-]+(?:\/outbound-(?:machine|bootstrap))?$/.test(file))return false;
 try{const lines=execFileSync('getfacl',['-cpn','--',file],{encoding:'utf8',timeout:2000,maxBuffer:4096}).trim().split('\n').filter(Boolean).sort();const perm=directory?'r-x':'r--';const expected=['user::'+perm,'user:'+uid+':'+perm,'group::---','mask::'+perm,'other::---'].sort();return JSON.stringify(lines)===JSON.stringify(expected);}catch{return false;}
}
/** systemd creates a service-private credential directory. Parent chain remains root-owned. */
function readServiceCredential(file:string,directory:string|undefined,name:string){
 if(!directory||!path.isAbsolute(directory)||directory.split('/').includes('..')||path.normalize(directory)!==directory||file!==path.join(directory,name))throw Error('outbound_credential_location');
 for(let p=path.dirname(directory);;p=path.dirname(p)){const st=fs.lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)!==0)throw Error('outbound_credential_parent');if(p===path.dirname(p))break;}
 const dir=fs.lstatSync(directory),uid=process.geteuid!();const systemdDirectory=dir.uid===0&&(dir.mode&0o777)===0o550&&systemdAcl(directory,uid,true);
 if(!dir.isDirectory()||dir.isSymbolicLink()||![0,uid].includes(dir.uid)||((dir.mode&0o077)!==0&&!systemdDirectory))throw Error('outbound_credential_directory');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);if(!st.isFile()||![0,uid].includes(st.uid)||(![0o400,0o600].includes(st.mode&0o777)&&!(systemdDirectory&&st.uid===0&&(st.mode&0o777)===0o440&&systemdAcl(file,uid,false)))||st.size<1||st.size>128)throw Error('outbound_credential_file');const data=Buffer.alloc(st.size);let pos=0;while(pos<data.length){const n=fs.readSync(fd,data,pos,data.length-pos,pos);if(!n)throw Error('outbound_credential_short_read');pos+=n;}return data;}finally{fs.closeSync(fd);}
}
export function loadOutboundStartupConfig(env:NodeJS.ProcessEnv){
 const file=env.TOWER_CUSTOMER_OUTBOUND_CONFIG;if(!file)return undefined;
 if(env.TOWER_CUSTOMER_SERVICE_CONFIG||env.TOWER_CUSTOMER_DELIVERY_POLICY)throw Error('outbound_startup_legacy_conflict');
 const bytes=readProtected(file,32768),config=parseOutboundStartupConfig(JSON.parse(bytes.toString()),env.TOWER_INSTANCE_ID);
 const secret=readServiceCredential(config.credentialFile,env.CREDENTIALS_DIRECTORY,'outbound-machine'),credential=secret.toString().replace(/\n$/,'');
 if(!/^[A-Za-z0-9_-]{43}$/.test(credential)||Buffer.from(credential,'base64url').length!==32||Buffer.from(credential,'base64url').toString('base64url')!==credential)throw Error('outbound_startup_credential');
 const bootstrap=readServiceCredential(config.bootstrapTokenFile,env.CREDENTIALS_DIRECTORY,'outbound-bootstrap'),bootstrapToken=bootstrap.toString().replace(/\n$/,'');if(!/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken)||Buffer.from(bootstrapToken,'base64url').toString('base64url')!==bootstrapToken||bootstrapToken===credential)throw Error('outbound_bootstrap_token');
 return {config,credential,bootstrapToken,assertCurrent(){if(!bootstrap.equals(readServiceCredential(config.bootstrapTokenFile,env.CREDENTIALS_DIRECTORY,'outbound-bootstrap'))||!bytes.equals(readProtected(file,32768))||!secret.equals(readServiceCredential(config.credentialFile,env.CREDENTIALS_DIRECTORY,'outbound-machine'))||config.installed.instanceId!==env.TOWER_INSTANCE_ID||Date.parse(config.expiresAt)<=Date.now())throw Error('outbound_startup_changed');}};
}
