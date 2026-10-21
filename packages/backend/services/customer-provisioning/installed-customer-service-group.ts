import {customerGatewayPolicyHttp} from './customer-gateway-policy-http.js';
import {createInstalledCustomerDelivery} from './customer-delivery-route.js';
import {startCustomerDeliveryListener} from './customer-delivery-listener.js';
import {startEnrollmentObservationListener} from './enrollment-observation-listener.js';
import {customerVaultObservation} from './customer-vault-observation.js';
import {startInstalledCustomerEnrollment,type InstalledCustomerEnrollmentConfig} from './customer-installed-enrollment-service.js';
import {startCustomerProvisioningServiceGroup} from './customer-provisioning-service-group.js';
import type {ApprovedObservationTarget} from './enrollment-observation-http.js';
import type {Server} from 'node:http';
const handle=(server:Server)=>({async close(){await new Promise<void>(r=>{server.close(()=>r());server.closeIdleConnections();});}});
/** One exact provider publication per private delivery/observation listener group.
 * Enrollment may be shared, but only when its relay publications/readback match this provider.
 */
export async function startInstalledCustomerServiceGroup(config:Omit<InstalledCustomerEnrollmentConfig,'receiver'> & {deliveryPolicyFile:string;deliveryPort:number;observationPort:number;observationToken:string;localInstanceId:()=>string;target:ApprovedObservationTarget}){
 if(new Set([config.port,config.deliveryPort,config.observationPort]).size!==3)throw Error('customer_service_ports_conflict');
 const delivery=createInstalledCustomerDelivery(config.deliveryPolicyFile,()=>config.serviceToken,config.localInstanceId);
 const d=delivery.approved,t=config.target;
 if(d.customerId!==t.customerId||d.instanceId!==t.instanceId||d.policyHash!==t.proposalHash||d.providerKind!==t.providerKind||d.approvalHash!==config.approvalHash)throw Error('customer_service_target_mismatch');
 const observation=customerVaultObservation({token:config.observationToken,targets:[t],async resolve(){delivery.assertInstalled();return {delivery:d,binding:await delivery.authority.readRuntimeBinding()};}});
 const policy=delivery.gatewaySetup?customerGatewayPolicyHttp({token:config.observationToken,instanceId:d.instanceId,profileId:delivery.gatewaySetup.profileId,credentialId:d.credentialId,consumerRef:async()=>(await delivery.receiver.readback(d)).providerResourceId,assertInstalled:delivery.assertInstalled,localInstanceId:async()=>config.localInstanceId()}):undefined;
 return startCustomerProvisioningServiceGroup({preflight:config.preflight,
  async startDelivery(){const s=await startCustomerDeliveryListener({TOWER_CUSTOMER_DELIVERY_POLICY:config.deliveryPolicyFile,TOWER_CUSTOMER_DELIVERY_PORT:String(config.deliveryPort),TOWER_CUSTOMER_DELIVERY_TOKEN:config.serviceToken,TOWER_INSTANCE_ID:d.instanceId},true,()=>delivery.route);if(!s)throw Error('customer_delivery_not_started');return handle(s);},
  startObservation:()=>startEnrollmentObservationListener(config.observationPort,{vault:observation,...(policy?{'gateway-policy':policy}:{})}),
  async startEnrollment(){const {listener}=await startInstalledCustomerEnrollment({...config,receiver:delivery.receiver});return handle(listener);}
 });
}
