import type {CustomerIntentPool,CustomerIntentClient} from './pg-intent-store.js';
export async function reserveCustomerSmoke(pool:CustomerIntentPool,instanceId:string,intentId:string,estimatedMicrousd:number,lockedAuthority:(c:CustomerIntentClient)=>Promise<void>){
 if(!Number.isSafeInteger(estimatedMicrousd)||estimatedMicrousd<=0||estimatedMicrousd>1000000||typeof lockedAuthority!=='function')throw Error('customer_smoke_reservation_invalid');
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await lockedAuthority(c);
  const intent=await c.query(`SELECT id FROM customer_service_intents WHERE id=$1::uuid AND instance_id=$2::uuid AND operation='smoke-execute'
   AND consumed_at IS NOT NULL AND revoked=false AND expires_at>clock_timestamp() FOR SHARE`,[intentId,instanceId]);
  if(intent.rowCount!==1)throw Error('intent_invalid');
  const gate=await c.query(`UPDATE customer_smoke_budgets SET reserved_microusd=reserved_microusd+$2,requests=requests+1
   WHERE instance_id=$1::uuid AND team_observed_at<=clock_timestamp() AND team_observed_at>=clock_timestamp()-interval '60 seconds'
   AND team_observed_microusd+reserved_microusd+$2<=team_limit_microusd
   AND smoke_spend_microusd+reserved_microusd+$2<=smoke_limit_microusd AND requests<max_requests`,[instanceId,estimatedMicrousd]);
  if(gate.rowCount!==1)throw Error('budget_denied');
  // Duplicate intent rolls the budget increment back; never grants a second reservation.
  await c.query('INSERT INTO customer_smoke_reservations(intent_id,instance_id,estimated_microusd) VALUES($1::uuid,$2::uuid,$3)',[intentId,instanceId,estimatedMicrousd]);
  await c.query('COMMIT');
 }catch{try{await c.query('ROLLBACK');}catch{}throw Error('customer_smoke_reservation_denied_or_unknown');}finally{c.release();}
}
export async function reconcileCustomerSmoke(pool:CustomerIntentPool,instanceId:string,intentId:string,requestId:string,actualMicrousd:number){
 if(!Number.isSafeInteger(actualMicrousd)||actualMicrousd<0||!/^[-A-Za-z0-9_]{1,120}$/.test(requestId))throw Error('customer_smoke_reconcile_invalid');
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  // Same lock order as reserve: budget then reservation.
  const budget=await c.query('SELECT instance_id FROM customer_smoke_budgets WHERE instance_id=$1::uuid FOR UPDATE',[instanceId]);if(budget.rowCount!==1)throw Error();
  const changed=await c.query(`UPDATE customer_smoke_reservations SET actual_microusd=$3,request_id=$4,reconciled_at=clock_timestamp()
   WHERE intent_id=$1::uuid AND instance_id=$2::uuid AND reconciled_at IS NULL AND estimated_microusd>=$3`,[intentId,instanceId,actualMicrousd,requestId]);
  if(changed.rowCount!==1)throw Error();
  // Keep the full reservation in Team accounting until an exhaustive provider snapshot explicitly absorbs it.
  const r=await c.query('UPDATE customer_smoke_budgets SET smoke_spend_microusd=smoke_spend_microusd+$2 WHERE instance_id=$1::uuid',[instanceId,actualMicrousd]);if(r.rowCount!==1)throw Error();
  await c.query('COMMIT');
 }catch{try{await c.query('ROLLBACK');}catch{}throw Error('customer_smoke_reconcile_denied_or_unknown');}finally{c.release();}
}
