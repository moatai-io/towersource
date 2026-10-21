import {pgCustomerSmokeLedger,type SmokeSqlPool} from './pg-smoke-ledger.js';
import {pgApprovalSmokeLedger} from './pg-approval-smoke-ledger.js';
import type {CustomerSmokeLedger} from './litellm-smoke-ports.js';
/** Selection comes only from an operator-published DB row. Missing additive
 * schema preserves legacy operation; other DB errors fail closed. No cache. */
export function installedSmokeLedger(pool:SmokeSqlPool,config:{instanceId:string;approvalHash:string;estimatedMicrousd:number;model:string}):CustomerSmokeLedger{
 const legacy=pgCustomerSmokeLedger(pool,config),scoped=pgApprovalSmokeLedger(pool,config);
 async function selected(){const c=await pool.connect();try{
  const table=await c.query<{present:boolean}>("SELECT to_regclass('public.customer_smoke_approval_budgets') IS NOT NULL AS present");
  if(!table.rows[0]?.present)return legacy;
  const row=await c.query('SELECT approval_hash FROM customer_smoke_approval_budgets WHERE instance_id=$1 AND approval_hash=$2',[config.instanceId,config.approvalHash]);return row.rowCount===1?scoped:legacy;
 }finally{c.release();}}
 return {async loadResponse(i){return (await selected()).loadResponse?.(i)??null;},async snapshot(){return (await selected()).snapshot();},async observeTeam(s,t){await (await selected()).observeTeam?.(s,t);},async estimate(i){return (await selected()).estimate(i);},async reserve(i,n){return (await selected()).reserve(i,n);},async reconcile(i,r,n){return (await selected()).reconcile(i,r,n);},async recordResponse(i,r){await (await selected()).recordResponse?.(i,r);}};
}
