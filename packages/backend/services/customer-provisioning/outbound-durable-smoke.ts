import type {SmokeSqlPool} from './pg-smoke-ledger.js';
import {consumeCustomerIntent} from './pg-intent-store.js';
import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
import type {CustomerSmokeServicePorts} from './smoke-handler.js';
import type {OutboundAiReport} from './outbound-ai-report-client.js';
/** A consumed intent without a reconciled reservation is an unknown outcome, not permission to retry. */
export function outboundDurableSmoke(pool:SmokeSqlPool,config:{customerId:string;instanceId:string;approvalHash:string;executionHash:string;intentId:string;binding:CustomerRuntimeBinding},ports:CustomerSmokeServicePorts){
 const input={customerId:config.customerId,instanceId:config.instanceId,approvalHash:config.approvalHash,operation:'smoke-execute' as const,intentId:config.intentId,binding:config.binding};
 async function snapshot(){
 // Historical outbound report contract is GPT-only. Never infer a model or
 // fabricate a GPT receipt for a newly approved DeepSeek smoke.
 if(config.binding.smokeModel!=='gpt-6.1-sol')throw Error('outbound_smoke_model_contract_denied');
 const c=await pool.connect();try{
 await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await assertLockedCustomerAuthority(c,input);
 const r=await c.query<{consumed:boolean;request_id:string|null;actual:string|null;reconciled:boolean}>(`SELECT i.consumed_at IS NOT NULL AS consumed,r.request_id,r.actual_microusd::text AS actual,r.reconciled_at IS NOT NULL AS reconciled
 FROM customer_service_intents i LEFT JOIN customer_smoke_reservations r ON r.intent_id=i.id AND r.instance_id=i.instance_id
 WHERE i.id=$1 AND i.customer_id=$2 AND i.instance_id=$3 AND i.approval_hash=$4 AND i.operation='smoke-execute'
 AND i.provider_kind IS NULL AND i.project_id=$5 AND i.actor_user_id=$6 AND i.revoked=false AND i.expires_at>clock_timestamp() FOR SHARE OF i`,[config.intentId,config.customerId,config.instanceId,config.approvalHash,config.binding.projectId,config.binding.actorUserId]);
 if(r.rows.length!==1)throw Error('outbound_smoke_intent_denied');
 const row=r.rows[0];let report:OutboundAiReport|null=null;
 if(row.reconciled){const cost=Number(row.actual);if(!row.consumed||!row.request_id||row.actual===null||!Number.isSafeInteger(cost)||cost<0||cost>1000000)throw Error('outbound_smoke_ledger_invalid');report={executionHash:config.executionHash,instanceId:config.instanceId,model:'gpt-6.1-sol',verified:true,requestId:row.request_id,evidenceId:config.intentId,usageMicrousd:cost};}
 await c.query('COMMIT');return {consumed:row.consumed,report};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 return {
 async assertCurrent(){await snapshot();},
 async readResult(){return (await snapshot()).report;},
 async ensureDurableSmoke(signal:AbortSignal):Promise<'reconciled'>{
 signal.throwIfAborted();const state=await snapshot();if(state.report)return 'reconciled';if(state.consumed){if(await ports.recover?.(config.intentId,signal,'gpt-6.1-sol')){if(!(await snapshot()).report)throw Error('outbound_smoke_recovery_unverified');return 'reconciled';}throw Error('outbound_smoke_outcome_unknown_no_replay');}
 await ports.usage();signal.throwIfAborted();
 await consumeCustomerIntent(pool,input,assertLockedCustomerAuthority);signal.throwIfAborted();
 await ports.execute({model:'gpt-6.1-sol',prompt:'Reply with exactly: TOWER_SMOKE_OK',maxOutputTokens:32,intentId:config.intentId});
 if(!(await snapshot()).report)throw Error('outbound_smoke_outcome_unknown_no_replay');return 'reconciled';
 }
 };
}
