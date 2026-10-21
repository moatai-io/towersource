import {startCentralIssuerService,type CentralIssuerServiceConfig} from './central-issuer-service.js';
import {installedCentralAttestation} from './installed-central-attestation.js';
import {fileCentralIssuerAuthority,fileCentralZuploAuthority} from './central-issuer-authority.js';
/** Trusted deployment entry with concrete receiver/primary verification; no no-op callbacks. */
export function startInstalledCentralIssuerService(config:Omit<CentralIssuerServiceConfig,'authority'> & {authority:Pick<CentralIssuerServiceConfig['authority'],'approvalDirectory'|'intentDirectory'>;selectionFile:string}){
 const verifier=installedCentralAttestation(config.selectionFile);
 const authorityConfig={...config.authority,attest:verifier.attest,async verifyReceiver(input:Parameters<CentralIssuerServiceConfig['authority']['verifyReceiver']>[0],receiver:Parameters<CentralIssuerServiceConfig['authority']['verifyReceiver']>[1]){
  const authority=input.providerKind==='zuplo'?fileCentralZuploAuthority(authorityConfig):fileCentralIssuerAuthority(authorityConfig);
  const contract=await authority.contractFor(input.approvalHash,input.providerKind);
  await verifier.verifyReceiver(contract,input,receiver);
 }};
 return startCentralIssuerService({...config,authority:authorityConfig});
}
