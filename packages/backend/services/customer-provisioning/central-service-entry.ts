import {readFile,lstat,open} from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';
import {startInstalledCentralIssuerService} from './installed-central-issuer-service.js';import {startCentralObservationService} from './central-observation-service.js';
type Issuer=Parameters<typeof startInstalledCentralIssuerService>[0];type Observer=Parameters<typeof startCentralObservationService>[0];
/** Central process config contains env references only. No automatic issue or database writes. */
export function parseCentralServiceConfig(x:any,env:NodeJS.ProcessEnv):{issuer:Issuer;observer:Observer}{
 const exact=(v:any,k:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==k.length||k.some(p=>!Object.hasOwn(v,p)))throw Error('central_config_shape_invalid');};
 exact(x,['schemaVersion','expiresAt','issuerPort','observationPort','issuerTokenEnv','observationTokenEnv','zuploTokenEnv','managementBaseUrl','managementTokenEnv','approvalDirectory','intentDirectory','selectionFile','targets']);
 if(x.schemaVersion!==1||!Number.isFinite(Date.parse(x.expiresAt))||Date.parse(x.expiresAt)<=Date.now()||!Array.isArray(x.targets)||!x.targets.length||x.targets.length>100)throw Error('central_config_invalid');
 for(const p of [x.issuerPort,x.observationPort])if(!Number.isInteger(p)||p<1024||p>65535)throw Error('central_config_port_invalid');if(x.issuerPort===x.observationPort)throw Error('central_config_port_conflict');
 for(const p of [x.approvalDirectory,x.intentDirectory,x.selectionFile])if(typeof p!=='string'||!path.isAbsolute(p)||p.split('/').includes('..'))throw Error('central_config_path_invalid');
 const u=new URL(x.managementBaseUrl);if(!['http:','https:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.hash||u.search)throw Error('central_management_not_local');
 const secret=(n:string)=>{if(typeof n!=='string'||!/^TOWER_[A-Z0-9_]+_(TOKEN|KEY)$/.test(n)||!env[n]||env[n]!.length<32||/[\r\n]/.test(env[n]!))throw Error('central_credential_unavailable');return env[n]!;};
 const management={baseUrl:x.managementBaseUrl,masterKey:secret(x.managementTokenEnv)},zuploManagementToken=secret(x.zuploTokenEnv);
 const targets=x.targets.map((t:any)=>{exact(t,['customerId','instanceId','proposalHash','providerKind','approvalHash','customerPolicy']);if(!['zuplo','litellm'].includes(t.providerKind)||!/^[a-f0-9]{64}$/.test(t.proposalHash)||!/^[a-f0-9]{64}$/.test(t.approvalHash)||typeof t.customerId!=='string'||!t.customerId||typeof t.instanceId!=='string')throw Error('central_target_invalid');let customerPolicy;
 if(t.providerKind==='zuplo'){exact(t.customerPolicy,['endpoint','tokenEnv']);const url=new URL(t.customerPolicy.endpoint);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw Error('central_policy_endpoint_invalid');customerPolicy={endpoint:t.customerPolicy.endpoint,token:secret(t.customerPolicy.tokenEnv)};}else if(t.customerPolicy!==null)throw Error('central_policy_extra');
 return {...t,customerPolicy};});
 const preflight=async()=>{if(Date.parse(x.expiresAt)<=Date.now())throw Error('central_config_expired');};
 return {issuer:{port:x.issuerPort,serviceToken:secret(x.issuerTokenEnv),management,zuploManagementToken,authority:{approvalDirectory:x.approvalDirectory,intentDirectory:x.intentDirectory},selectionFile:x.selectionFile,preflight},observer:{port:x.observationPort,token:secret(x.observationTokenEnv),approvalDirectory:x.approvalDirectory,intentDirectory:x.intentDirectory,zuploManagementToken,litellmManagement:management,targets}};
}
export async function startCentralServices(file:string,env:NodeJS.ProcessEnv){
 if(!path.isAbsolute(file)||file.split('/').includes('..'))throw Error('central_config_path_invalid');
 for(let p=path.dirname(file);;p=path.dirname(p)){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error('central_config_unprotected');if(p===path.dirname(p))break;}
 const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
 try{const s=await f.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.size>262144)throw Error('central_config_unprotected');const b=Buffer.alloc(262145);const n=(await f.read(b,0,b.length,0)).bytesRead;if(n>262144)throw Error('central_config_large');bytes=b.subarray(0,n);}finally{await f.close();}
 const raw=JSON.parse(bytes.toString()),c=parseCentralServiceConfig(raw,env);
 const {installedCentralAttestation}=await import('./installed-central-attestation.js');
 const {fileCentralIssuerAuthority,fileCentralZuploAuthority}=await import('./central-issuer-authority.js');
 const verifier=installedCentralAttestation(c.issuer.selectionFile);const options={...c.issuer.authority,attest:verifier.attest,async verifyReceiver(){throw Error('startup_no_receiver_mutation');}};
 for(const target of c.observer.targets){const a=target.providerKind==='zuplo'?fileCentralZuploAuthority(options):fileCentralIssuerAuthority(options);const contract=await a.contractFor(target.approvalHash,target.providerKind);await verifier.attest(contract);if(contract.instanceId!==target.instanceId||contract.customerId!==target.customerId||contract.policyHash!==target.proposalHash)throw Error('central_startup_contract_mismatch');}
 await c.issuer.preflight();
 const observer=await startCentralObservationService(c.observer);let issuer:Awaited<ReturnType<typeof startInstalledCentralIssuerService>>;
 try{issuer=await startInstalledCentralIssuerService(c.issuer);}catch(e){await observer.close();throw e;}
 let closed=false;const close=async()=>{if(closed)return;closed=true;clearInterval(timer);await Promise.allSettled([issuer.close(),observer.close()]);};
 const timer=setInterval(()=>{void readFile(file).then(b=>{if(!b.equals(bytes)||Date.parse(raw.expiresAt)<=Date.now())return close();}).catch(()=>close());},1000);timer.unref();
 return {close};
}
