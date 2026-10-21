import {queryOne} from '../../db/pg-repo.js';
import {authorizeCustomerService,type CustomerServiceAuthority} from './service-boundary.js';
/** Read-only exact approved run evidence. Never reserves or repeats the paid request. */
export async function customerSmokeRecovery(req:Request,config:{serviceToken:string;authority:CustomerServiceAuthority}){
 const reply=(status:number,body:object)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(req.method!=='POST')return reply(405,{error:'method_denied'});
 try{
  const reader=req.body?.getReader();if(!reader)return reply(400,{error:'body_missing'});let size=0;const parts:Uint8Array[]=[];
  try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>4096)return reply(413,{error:'body_large'});parts.push(x.value);}}finally{await reader.cancel();}
  const x=JSON.parse(Buffer.concat(parts).toString());if(!x||Object.keys(x).sort().join(',')!=='approvalHash,customerId,instanceId')return reply(400,{error:'body_invalid'});
  const {binding}=await authorizeCustomerService({...x,operation:'smoke-usage'},req.headers.get('authorization')??undefined,config.serviceToken,config.authority);
  const row=await queryOne<{receipts:Array<{id:string;request_id:string;actual:string;model:string}>}>(`SELECT json_agg(json_build_object('id',i.id,'request_id',r.request_id,'actual',r.actual_microusd::text,'model',e.model)) receipts
   FROM customer_service_intents i JOIN customer_smoke_reservations r ON r.intent_id=i.id
   JOIN customer_smoke_response_evidence e ON e.intent_id=i.id AND e.approval_hash=i.approval_hash AND e.request_id=r.request_id AND e.sentinel='TOWER_SMOKE_OK' AND e.model=$6
   WHERE i.customer_id=$1 AND i.instance_id=$2::uuid AND i.approval_hash=$3 AND i.project_id=$4::uuid AND i.actor_user_id=$5
   AND i.operation='smoke-execute' AND i.revoked=false AND i.expires_at>clock_timestamp() AND i.consumed_at IS NOT NULL
   AND r.instance_id=i.instance_id AND r.reconciled_at IS NOT NULL`,[x.customerId,x.instanceId,x.approvalHash,binding.projectId,binding.actorUserId,binding.smokeModel]);
  if(!Array.isArray(row?.receipts)||row.receipts.length!==1)throw Error('ambiguous');const r=row.receipts[0],amount=Number(r.actual);
  if(r.model!==binding.smokeModel||!r.request_id||!r.id||!Number.isSafeInteger(amount)||amount<0||amount>1000000)throw Error('invalid');
  return reply(200,{executionHash:x.approvalHash,instanceId:x.instanceId,model:r.model,verified:true,requestId:r.request_id,evidenceId:r.id,usageMicrousd:amount});
 }catch{return reply(503,{error:'original_smoke_evidence_unavailable'});}
}
