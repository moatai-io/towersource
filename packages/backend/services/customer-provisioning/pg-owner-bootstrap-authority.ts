import {queryOne} from '../../db/pg-repo.js';
import type {ApprovedOwnerBootstrap,OwnerBootstrapAuthority} from './owner-bootstrap.js';
type Row={approval:ApprovedOwnerBootstrap;expires_at:Date|string;revoked:boolean};
export interface InstalledOwnerBinding {instanceId:string;approvalHash:string;}
/** Read-only consumer of operator-published approvals. No request body may select this binding.
 * Fresh reads do not provide transaction fencing across project/user writes: deployment must
 * serialize installation and revocation until those writes share a durable fence.
 */
export function pgOwnerBootstrapAuthority(installed:()=>Promise<InstalledOwnerBinding>,approvalHash:string):OwnerBootstrapAuthority {
 if(!/^[a-f0-9]{64}$/.test(approvalHash))throw Error('owner_authority_config_invalid');
 async function read(){
  const row=await queryOne<Row>('SELECT approval,expires_at,revoked FROM customer_owner_bootstrap_approvals WHERE approval_hash=$1 AND revoked=false AND expires_at>NOW()',[approvalHash]);
  if(!row||row.revoked!==false||!Number.isFinite(new Date(row.expires_at).getTime())||new Date(row.expires_at).getTime()<=Date.now()||row.approval?.approvalHash!==approvalHash)throw Error('owner_approval_unavailable');
  const value=structuredClone(row.approval);await check(value.instanceId,value.approvalHash);return value;
 }
 async function check(instanceId:string,hash:string){const local=await installed();if(local.instanceId!==instanceId||local.approvalHash!==hash||hash!==approvalHash)throw Error('owner_installed_binding_mismatch');}
 return {load:read,assertInstalledIdentity:check,async assertCurrent(expected){
  const current=await read();
  for(const k of ['issuer','customerId','instanceId','approvalHash','creationCommandId','projectName'] as const)if(current[k]!==expected[k])throw Error('owner_approval_changed');
  for(const k of ['subjectId','organizationId','instanceId','role','displayName'] as const)if(current.identity?.[k]!==expected.identity[k])throw Error('owner_approval_changed');
 }};
}
