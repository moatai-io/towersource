import {isCustomerSmokeModel} from './service-boundary.js';
import type {CustomerSmokeLedger} from './litellm-smoke-ports.js';
export interface SmokeSqlClient {query<T=Record<string,unknown>>(sql:string,args?:unknown[]):Promise<{rows:T[];rowCount:number|null}>;release():void;}
export interface SmokeSqlPool {connect():Promise<SmokeSqlClient>;}
/** Installed candidate schema only. Prices are operator-approved conservative bounds, never caller supplied. */
export function pgCustomerSmokeLedger(pool:SmokeSqlPool,config:{instanceId:string;approvalHash:string;estimatedMicrousd:number;model:string}):CustomerSmokeLedger {
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 if(!isCustomerSmokeModel(config.model)||!uuid.test(config.instanceId)||! /^[a-f0-9]{64}$/.test(config.approvalHash)||!Number.isSafeInteger(config.estimatedMicrousd)||config.estimatedMicrousd<=0||config.estimatedMicrousd>1000000)throw Error('smoke_ledger_config_invalid');
 const frozen=Object.freeze({...config});
 async function lockModel(c:SmokeSqlClient){const r=await c.query('SELECT public.lock_customer_smoke_model($1::text,$2::uuid,$3::text) AS model',[frozen.approvalHash,frozen.instanceId,frozen.model]);if(r.rowCount!==1)throw Error('smoke_approved_model_denied');}
 async function transaction<T>(run:(c:SmokeSqlClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query('BEGIN');const result=await run(c);await c.query('COMMIT');return result;}catch{try{await c.query('ROLLBACK');}catch{}throw Error('smoke_ledger_denied_or_unknown');}finally{c.release();}}
 return {
  async observeTeam(spend,observedAt){if(!Number.isSafeInteger(spend)||spend<0||!Number.isFinite(Date.parse(observedAt))||Math.abs(Date.now()-Date.parse(observedAt))>60000)throw Error('smoke_team_observation_invalid');const c=await pool.connect();try{const r=await c.query(`UPDATE customer_smoke_budgets SET team_observed_microusd=$2,team_observed_at=$3::timestamptz WHERE instance_id=$1 AND team_observed_at<=$3::timestamptz RETURNING instance_id`,[frozen.instanceId,spend,observedAt]);if(r.rowCount!==1)throw Error('smoke_team_observation_denied');}finally{c.release();}},
  async snapshot(){const c=await pool.connect();try{const r=await c.query<{spend:string;requests:number}>('SELECT smoke_spend_microusd::text spend,requests FROM customer_smoke_budgets WHERE instance_id=$1',[frozen.instanceId]);if(r.rows.length!==1)throw Error('smoke_ledger_missing');const spendMicrousd=Number(r.rows[0].spend),requests=Number(r.rows[0].requests);if(!Number.isSafeInteger(spendMicrousd)||spendMicrousd<0||!Number.isSafeInteger(requests)||requests<0)throw Error('smoke_ledger_invalid');return {spendMicrousd,requests};}finally{c.release();}},
  async estimate(input){if(input.model!==frozen.model||input.prompt!=='Reply with exactly: TOWER_SMOKE_OK'||input.maxOutputTokens!==32)throw Error('smoke_estimate_input_invalid');await transaction(async c=>{await lockModel(c);});return frozen.estimatedMicrousd;},
  async reserve(intentId,estimated){if(!uuid.test(intentId)||estimated!==frozen.estimatedMicrousd)throw Error('smoke_reservation_invalid');await transaction(async c=>{await lockModel(c);
   // The execute handler has consumed this exact intent. Verify current authority again under locks.
   const a=await c.query(`SELECT public.lock_customer_smoke_intent($1::uuid,$2::uuid,$3::text) AS id`,[intentId,frozen.instanceId,frozen.approvalHash]);if(a.rowCount!==1)throw Error();
   const b=await c.query(`UPDATE customer_smoke_budgets SET reserved_microusd=reserved_microusd+$2,requests=requests+1
    WHERE instance_id=$1 AND requests<max_requests AND team_observed_at<=clock_timestamp()
    AND team_observed_at>clock_timestamp()-interval '60 seconds'
    AND smoke_spend_microusd+reserved_microusd+$2<=smoke_limit_microusd
    AND team_observed_microusd+reserved_microusd+$2<=team_limit_microusd RETURNING instance_id`,[frozen.instanceId,estimated]);if(b.rowCount!==1)throw Error();
   await c.query('INSERT INTO customer_smoke_reservations(intent_id,instance_id,estimated_microusd) VALUES($1,$2,$3)',[intentId,frozen.instanceId,estimated]);
  });},
  async reconcile(intentId,requestId,actual){if(!uuid.test(intentId)||! /^[-A-Za-z0-9_:./=+]{1,2048}$/.test(requestId)||!Number.isSafeInteger(actual)||actual<0||actual>frozen.estimatedMicrousd)throw Error('smoke_reconcile_invalid');await transaction(async c=>{await lockModel(c);
   const r=await c.query<{estimated:string}>(`UPDATE customer_smoke_reservations SET actual_microusd=$3,request_id=$4,reconciled_at=clock_timestamp()
    WHERE intent_id=$1 AND instance_id=$2 AND reconciled_at IS NULL AND estimated_microusd>=$3 RETURNING estimated_microusd::text estimated`,[intentId,frozen.instanceId,actual,requestId]);if(r.rows.length!==1)throw Error();
   const estimated=Number(r.rows[0].estimated);if(!Number.isSafeInteger(estimated)||estimated<=0)throw Error();
   const b=await c.query(`UPDATE customer_smoke_budgets SET reserved_microusd=reserved_microusd-$2,smoke_spend_microusd=smoke_spend_microusd+$3
    WHERE instance_id=$1 AND reserved_microusd>=$2 RETURNING instance_id`,[frozen.instanceId,estimated,actual]);if(b.rowCount!==1)throw Error();
  });},
 };
}
