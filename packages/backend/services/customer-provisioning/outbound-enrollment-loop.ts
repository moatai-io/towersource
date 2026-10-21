import type {outboundEnrollmentClient} from './outbound-enrollment-client.js';
/** Bounded sequential polling within the existing Tower process. Idle is not proof of completion;
 * local persisted lifecycle decides completion. Never starts an inbound listener.
 */
export async function runOutboundEnrollmentLoop(client:ReturnType<typeof outboundEnrollmentClient>,options:{signal:AbortSignal;maxAttempts:number;deadlineMs:number;isComplete():Promise<boolean>;wait(ms:number,signal:AbortSignal):Promise<void>;random?:()=>number;now?:()=>number}){
 if(!Number.isInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>1000||!Number.isFinite(options.deadlineMs))throw Error('outbound_loop_bounds_invalid');
 const now=options.now??Date.now,random=options.random??Math.random;let attempt=0,idleCount=0;
 while(attempt<options.maxAttempts&&now()<options.deadlineMs){options.signal.throwIfAborted();if(await options.isComplete())return {status:'complete' as const,attempts:attempt};
  const r=await client.tick(options.signal);attempt++;idleCount=r.status==='idle'?Math.min(idleCount+1,5):0;
  if(await options.isComplete())return {status:'complete' as const,attempts:attempt};
  if(attempt>=options.maxAttempts)break;const jitter=random();if(!Number.isFinite(jitter)||jitter<0||jitter>=1)throw Error('outbound_loop_random_invalid');const delay=Math.min(60000,5000*2**idleCount)*(0.8+0.2*jitter);const remaining=options.deadlineMs-now();if(remaining<=0)break;await options.wait(Math.min(delay,remaining),options.signal);
 }
 return {status:'paused' as const,attempts:attempt};
}
