import {startPgApprovedCustomerInstallation} from './pg-installation-runtime.js';
import {pgCustomerRuntimeStore} from './pg-runtime-store.js';
import {installedEnrollmentConfig} from './installed-enrollment-config.js';
import {publishedCustomerRelayAuthority} from './published-customer-relay-authority.js';
import {customerRelayEnrollmentPorts} from './customer-relay-enrollment-ports.js';
import type {InstalledOwnerBinding} from './pg-owner-bootstrap-authority.js';
import type {CustomerCredentialReceiverPorts} from './central-delivery.js';
export interface InstalledCustomerEnrollmentConfig {
 port:number;serviceToken:string;approvalHash:string;installed:()=>Promise<InstalledOwnerBinding>;preflight():Promise<void>;
 relay:{approvalDirectory:string;intentDirectory:string;endpoint:string;serviceToken:string};
 /** The same Vault receiver used by the private delivery listener. No independent receipt cache. */
 receiver:CustomerCredentialReceiverPorts;
}
/** Complete enrollment composition; separately deployed delivery listener owns secret storage. */
export function startInstalledCustomerEnrollment(config:InstalledCustomerEnrollmentConfig){
 return startPgApprovedCustomerInstallation({port:config.port,approvalHash:config.approvalHash,installed:config.installed,preflight:config.preflight,
  async receiverFor(owner){
   const store=pgCustomerRuntimeStore(async()=>(await config.installed()).instanceId,config.approvalHash);
   const authority=publishedCustomerRelayAuthority({...config.relay,readback:async(input)=>config.receiver.readback(input)});
   const ports=customerRelayEnrollmentPorts(authority);
   return installedEnrollmentConfig(owner,store,ports,config.serviceToken);
  }
 });
}
