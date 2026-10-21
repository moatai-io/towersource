export interface PrivateServiceHandle {close():Promise<void>;}
export interface CustomerProvisioningServiceGroup {
 /** Validates all protected configuration and schema before any listener is opened. */
 preflight():Promise<void>;
 startDelivery():Promise<PrivateServiceHandle>;
 startObservation():Promise<PrivateServiceHandle>;
 startEnrollment():Promise<PrivateServiceHandle>;
}
/** Delivery/observation must be available before accepting enrollment requests.
 * Failure closes already started listeners but never rolls back bootstrap/Vault writes.
 */
export async function startCustomerProvisioningServiceGroup(config:CustomerProvisioningServiceGroup){
 for(const k of ['preflight','startDelivery','startObservation','startEnrollment'] as const)if(typeof config?.[k]!=='function')throw Error('customer_service_group_unconfigured');
 await config.preflight();const handles:PrivateServiceHandle[]=[];let closing=false;
 const close=async()=>{if(closing)return;closing=true;const failures:unknown[]=[];for(const h of handles.reverse())try{await h.close();}catch(e){failures.push(e);}if(failures.length)throw Error('customer_service_group_cleanup_incomplete');};
 try{for(const start of [config.startDelivery,config.startObservation,config.startEnrollment]){const h=await start();if(!h||typeof h.close!=='function')throw Error('customer_service_handle_invalid');handles.push(h);}return {close};}
 catch(error){try{await close();}catch{throw Error('customer_service_start_failed_cleanup_incomplete');}throw error;}
}
