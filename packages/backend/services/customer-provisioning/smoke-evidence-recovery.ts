import {isCustomerSmokeModel} from './service-boundary.js';
import {verifiedSmokeResponse,decimalUsdToMicrousd,type CustomerSmokeLedger} from './litellm-smoke-ports.js';
/** Reconciliation only: intentionally has no credentials, fetch or execute port.
 * Caller loads protected evidence and rechecks current local authority before
 * calling this function; the ledger enforces reservation ownership atomically. */
export async function recoverSmokeEvidence(input:{intentId:string;response:Record<string,any>;maximumMicrousd:number;model:string},ledger:Pick<CustomerSmokeLedger,'reconcile'>,spend:(intentId:string,signal:AbortSignal)=>Promise<Array<{requestId:string;rootTurnId:string;status:string;spend:unknown}>>,signal:AbortSignal){
 if(!/^[a-f0-9-]{36}$/i.test(input.intentId)||!Number.isSafeInteger(input.maximumMicrousd)||input.maximumMicrousd<=0||input.maximumMicrousd>1000000)throw Error('smoke_recovery_input_invalid');
 signal.throwIfAborted();if(!isCustomerSmokeModel(input.model))throw Error('smoke_recovery_model_invalid');const id=verifiedSmokeResponse(input.response,input.model);
 const rows=await spend(input.intentId,signal);signal.throwIfAborted();
 if(rows.length!==1||rows[0].requestId!==id||rows[0].rootTurnId!==input.intentId||rows[0].status!=='success')throw Error('smoke_recovery_evidence_mismatch');
 const actual=decimalUsdToMicrousd(rows[0].spend);if(actual>input.maximumMicrousd)throw Error('smoke_recovery_price_bound_exceeded');
 await ledger.reconcile(input.intentId,id,actual);return {requestId:id,usageMicrousd:actual,newInference:false as const};
}
