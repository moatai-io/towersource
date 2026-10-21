import {getPgPool} from '../../db/pg.js';
import type {ApprovedOwnerBootstrap,OwnerBootstrapAuthority} from './owner-bootstrap.js';
import type {InstalledOwnerBinding} from './pg-owner-bootstrap-authority.js';
/** Serializes installation against approval UPDATE/DELETE. Owner/project writes use separate
 * connections: rollback here releases the lock, it does NOT undo those writes. Never auto-retry.
 * Connection loss is an ambiguous partial installation, not a rollback guarantee.
 */
export async function withPgOwnerInstallationFence<T>(installed:()=>Promise<InstalledOwnerBinding>,approvalHash:string,run:(authority:OwnerBootstrapAuthority)=>Promise<T>):Promise<T>{
 if(!/^[a-f0-9]{64}$/.test(approvalHash))throw Error('owner_fence_config_invalid');
 const client=await getPgPool().connect();let active=true;let connectionLost=false;
 const lost=()=>{connectionLost=true;};client.on('error',lost);
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  const result=await client.query<{approval:ApprovedOwnerBootstrap}>(`SELECT approval FROM customer_owner_bootstrap_approvals WHERE approval_hash=$1 AND revoked=false AND expires_at>clock_timestamp() FOR UPDATE`,[approvalHash]);
  if(result.rows.length!==1)throw Error('owner_approval_unavailable');
  const approved=structuredClone(result.rows[0].approval);
  const ensure=()=>{if(!active||connectionLost)throw Error('owner_installation_fence_lost');};
  const check=async(instanceId:string,hash:string)=>{ensure();const local=await installed();ensure();if(hash!==approvalHash||local.approvalHash!==hash||local.instanceId!==instanceId)throw Error('owner_installed_binding_mismatch');};
  const current=async(expected:Readonly<ApprovedOwnerBootstrap>)=>{
   ensure();await check(expected.instanceId,expected.approvalHash);
   const fresh=await client.query<{approval:ApprovedOwnerBootstrap}>('SELECT approval FROM customer_owner_bootstrap_approvals WHERE approval_hash=$1 AND revoked=false AND expires_at>clock_timestamp()',[approvalHash]);ensure();
   if(fresh.rows.length!==1)throw Error('owner_approval_unavailable');
   const actual=fresh.rows[0].approval;
   for(const key of ['issuer','customerId','instanceId','approvalHash','creationCommandId','projectName'] as const)if(actual[key]!==expected[key])throw Error('owner_approval_changed');
   for(const key of ['subjectId','organizationId','instanceId','role','displayName'] as const)if(actual.identity?.[key]!==expected.identity?.[key])throw Error('owner_approval_changed');
  };
  await current(approved);
  const authority:OwnerBootstrapAuthority={load:async()=>{await current(approved);return structuredClone(approved);},assertInstalledIdentity:check,assertCurrent:current};
  const value=await run(authority);await current(approved);await client.query('COMMIT');return value;
 }catch(error){try{await client.query('ROLLBACK');}catch{/* Preserve original failure; caller must reconcile partial writes. */}throw error;
 }finally{active=false;client.removeListener('error',lost);client.release(connectionLost);}
}
