import type {outboundEnrollmentClient} from './outbound-enrollment-client.js';
import type {outboundAiReportClient} from './outbound-ai-report-client.js';
/** Sequential customer lifecycle. The durable smoke adapter owns intent consumption
 * and unknown-outcome reconciliation; it must NEVER replay an uncertain paid request.
 * Intake acknowledgement is not CP acceptance or whole-instance readiness.
 */
export async function runOutboundCustomer(input:{delivery:ReturnType<typeof outboundEnrollmentClient>;report:ReturnType<typeof outboundAiReportClient>;assertCurrent():Promise<void>;credentialsReady():Promise<boolean>;ensureDurableSmoke(signal:AbortSignal):Promise<'pending'|'reconciled'>;wait(ms:number,signal:AbortSignal):Promise<void>;signal:AbortSignal;maxAttempts:number;deadlineMs:number;now?:()=>number}){
 if(!Number.isInteger(input.maxAttempts)||input.maxAttempts<1||input.maxAttempts>120||!Number.isFinite(input.deadlineMs)||input.deadlineMs<1||input.deadlineMs>1800000)throw Error('outbound_runner_limits_invalid');
 const now=input.now??Date.now,deadline=now()+input.deadlineMs;let smokeReconciled=false;
 for(let attempt=0;attempt<input.maxAttempts;attempt++){
 input.signal.throwIfAborted();if(now()>=deadline)throw Error('outbound_runner_deadline');
 await input.assertCurrent();
 // Drain delivery/ACK even when local Vault already contains the key after ACK loss.
 const deliveryResult=await input.delivery.tick(input.signal);
 // Acknowledging one delivery does not prove the whole queue is drained.
 if(deliveryResult.status==='idle'&&await input.credentialsReady()){
  await input.assertCurrent();if(!smokeReconciled)smokeReconciled=await input.ensureDurableSmoke(input.signal)==='reconciled';
  if(smokeReconciled){try{const result=await input.report.tick(input.signal);if(result.status==='received')return {status:'reported' as const,verifiedByControlPlane:false as const};}catch(error){input.signal.throwIfAborted();if(!(error instanceof Error)||error.message!=='outbound_report_request_failed')throw error;/* Only retry report admission, never paid execution. */}}
 }
 if(attempt+1<input.maxAttempts)await input.wait(Math.min(5000,Math.max(0,deadline-now())),input.signal);
 }
 throw Error('outbound_runner_attempts_exhausted');
}
