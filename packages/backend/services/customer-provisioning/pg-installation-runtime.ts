import {bootstrapApprovedCustomerOwner} from './owner-bootstrap.js';
import {withPgOwnerInstallationFence} from './pg-owner-installation-fence.js';
import {startCustomerEnrollmentListener} from './enrollment-listener.js';
import type {InstalledOwnerBinding} from './pg-owner-bootstrap-authority.js';
import type {CustomerInstallationRuntime} from './installation-runtime.js';
/** Explicit trusted deployment entry. Does not activate itself or issue provider credentials. */
export async function startPgApprovedCustomerInstallation(input:Omit<CustomerInstallationRuntime,'ownerAuthority'> & {installed:()=>Promise<InstalledOwnerBinding>;approvalHash:string}){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535||typeof input.preflight!=='function'||typeof input.receiverFor!=='function')throw Error('installation_config_invalid');
 await input.preflight();
 const owner=await withPgOwnerInstallationFence(input.installed,input.approvalHash,authority=>bootstrapApprovedCustomerOwner(authority));
 // Listener starts only after lock commit; its authority must recheck revocation per request.
 const receiver=await input.receiverFor(Object.freeze(owner));
 const listener=await startCustomerEnrollmentListener(receiver,input.port);
 return {owner,listener};
}
