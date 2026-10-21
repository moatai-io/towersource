import {bootstrapApprovedCustomerOwner,type OwnerBootstrapAuthority} from './owner-bootstrap.js';
import {startCustomerEnrollmentListener} from './enrollment-listener.js';
type ListenerConfig=Parameters<typeof startCustomerEnrollmentListener>[0];
type Owner=Awaited<ReturnType<typeof bootstrapApprovedCustomerOwner>>;
export interface CustomerInstallationRuntime {
 ownerAuthority:OwnerBootstrapAuthority;
 /** Must validate all trusted deployment inputs without changing provider or database state. */
 preflight():Promise<void>;
 /** Bind receiver authority to the installed local actor/Project, never caller-supplied IDs. */
 receiverFor(owner:Readonly<Owner>):Promise<ListenerConfig>;
 port:number;
}
/** Explicit installation composition, not an automatic startup hook. No provider key issuance here. */
export async function startApprovedCustomerInstallation(input:CustomerInstallationRuntime){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535)throw Error('installation_port_invalid');
 if(typeof input.preflight!=='function'||typeof input.receiverFor!=='function'||
  ['load','assertInstalledIdentity','assertCurrent'].some(k=>typeof input.ownerAuthority?.[k as keyof OwnerBootstrapAuthority]!=='function'))throw Error('installation_authority_unconfigured');
 await input.preflight();
 const owner=Object.freeze(await bootstrapApprovedCustomerOwner(input.ownerAuthority));
 const receiver=await input.receiverFor(owner);
 const listener=await startCustomerEnrollmentListener(receiver,input.port);
 // A failed listener start does not roll back the idempotent approved owner installation.
 return {owner,listener};
}
