import type {ApprovedZuploKeyPolicy} from './zuplo-key-issuer.js';
import type {CentralZuploRuntimeAuthority} from './central-zuplo-runtime.js';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {centralRelayContractHash,type CentralRelayContract} from './central-relay.js';
import type {ApprovedDelivery} from './central-delivery.js';
import type {AutoLiteLlmEnrollmentPolicy} from './litellm-auto-enrollment.js';
import type {CustomerDeliveryTransportConfig} from './central-http-delivery.js';
import type {CentralLiteLlmRuntimeAuthority} from './central-litellm-runtime.js';
export interface PublishedIssuerApproval<P=AutoLiteLlmEnrollmentPolicy> {
 contract:CentralRelayContract; policy:P; receiver:CustomerDeliveryTransportConfig;
 intentId:string; expiresAt:string; revoked:boolean;
}
/** Local operator-published authority. Private config files; irreversible one-shot journal, no provider replay. */
type AuthorityConfig={approvalDirectory:string;intentDirectory:string;
 attest(contract:Readonly<CentralRelayContract>):Promise<void>;
 verifyReceiver(input:ApprovedDelivery,receiver:CustomerDeliveryTransportConfig):Promise<void>;
 now?:()=>number;
};
export function fileCentralIssuerAuthority(config:AuthorityConfig):CentralLiteLlmRuntimeAuthority & {originalIntent(hash:string,kind:'zuplo'|'litellm'):Promise<string>}{return fileProviderAuthority<AutoLiteLlmEnrollmentPolicy>(config,'litellm');}
export function fileCentralZuploAuthority(config:AuthorityConfig):CentralZuploRuntimeAuthority & {originalIntent(hash:string,kind:'zuplo'|'litellm'):Promise<string>}{return fileProviderAuthority<ApprovedZuploKeyPolicy>(config,'zuplo');}
function fileProviderAuthority<P extends AutoLiteLlmEnrollmentPolicy|ApprovedZuploKeyPolicy>(config:AuthorityConfig,providerKind:'litellm'|'zuplo'){
 if(!path.isAbsolute(config.approvalDirectory)||!path.isAbsolute(config.intentDirectory)||typeof config.attest!=='function'||typeof config.verifyReceiver!=='function')throw Error('issuer_authority_config_invalid');
 const now=config.now??Date.now;
 async function privateDirectory(dir:string){const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid?.())throw Error('issuer_authority_directory_invalid');}
 async function approval(hash:string,kind:string):Promise<PublishedIssuerApproval<P>>{
  if(!/^[a-f0-9]{64}$/.test(hash)||kind!==providerKind)throw Error('issuer_approval_denied');
  await privateDirectory(config.approvalDirectory);
  const f=await open(path.join(config.approvalDirectory,(providerKind==='litellm'?hash:hash+'.zuplo')+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await f.stat();if(!s.isFile()||(s.mode&0o077)!==0||s.uid!==process.getuid?.()||s.size>32768)throw Error('issuer_approval_file_invalid');
   // lstat also rejects symlinks; deployment directory cannot be written by other principals.
   if((await lstat(path.join(config.approvalDirectory,(providerKind==='litellm'?hash:hash+'.zuplo')+'.json'))).isSymbolicLink())throw Error('issuer_approval_file_invalid');
   const a=JSON.parse(await f.readFile('utf8')) as PublishedIssuerApproval<P>;
   centralRelayContractHash(a.contract);
   if(a.contract.approvalHash!==hash||a.contract.providerKind!==kind||a.revoked!==false||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=now()||! /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(a.intentId))throw Error('issuer_approval_denied');
   for(const k of ['customerId','instanceId','approvalHash','policyHash','credentialId'] as const)if(a.policy[k]!==a.contract[k])throw Error('issuer_policy_mismatch');
   return a;
  }finally{await f.close();}
 }
 async function bound(input:ApprovedDelivery){const a=await approval(input.approvalHash,input.providerKind);
  if(a.intentId!==input.intentId||Object.keys(input).length!==7||(['customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'] as const).some(k=>input[k]!==a.contract[k]))throw Error('issuer_intent_mismatch');return a;
 }
 return {
  originalIntent:async(hash:string,kind:'zuplo'|'litellm')=>(await approval(hash,kind)).intentId,
  contractFor:async(hash:string,kind:'zuplo'|'litellm')=>(await approval(hash,kind)).contract,
  async authorizeContract(hash:string,input:ApprovedDelivery){if(centralRelayContractHash((await bound(input)).contract)!==hash)throw Error('issuer_contract_mismatch');},
  attest:config.attest,
  async consumeRelayIntent(hash:string,input:ApprovedDelivery){
   if(centralRelayContractHash((await bound(input)).contract)!==hash)throw Error('issuer_contract_mismatch');
   await privateDirectory(config.intentDirectory);
   const f=await open(path.join(config.intentDirectory,input.intentId+'.json'),'wx',0o600);
   try{await f.writeFile(JSON.stringify({intentId:input.intentId,contractHash:hash,consumedAt:new Date(now()).toISOString(),status:'consumed_no_automatic_replay'})+'\n');await f.sync();}finally{await f.close();}
   const dir=await open(config.intentDirectory,'r');try{await dir.sync();}finally{await dir.close();}
  },
  async approvedDelivery(input:ApprovedDelivery){const a=await bound(input);return {policy:a.policy,receiver:a.receiver};},
  verifyReceiver:config.verifyReceiver,
 };
}
