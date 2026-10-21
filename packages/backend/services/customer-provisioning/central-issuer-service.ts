import {zuploManagementHttp} from './zuplo-management-http.js';
import {centralZuploRuntime} from './central-zuplo-runtime.js';
import {centralProviderRuntime} from './central-provider-runtime.js';
import {fileCentralIssuerAuthority,fileCentralZuploAuthority} from './central-issuer-authority.js';
import {localLiteLlmManagement} from './litellm-management-http.js';
import {centralLiteLlmRuntime} from './central-litellm-runtime.js';
import {startCentralIssuerListener} from './central-issuer-listener.js';
type AuthorityConfig=Parameters<typeof fileCentralIssuerAuthority>[0];
export interface CentralIssuerServiceConfig {
 port:number;serviceToken:string;
 /** Injected central management credential; never copied to customer or approval file. */
 zuploManagementToken?:string;
 management:Parameters<typeof localLiteLlmManagement>[0];
 authority:AuthorityConfig;
 /** Read-only deployment attestation; no provider or approval mutations. */
 preflight():Promise<void>;
}
/** Explicit central-host startup. No environment discovery, dynamic plugins, or key issuance at boot. */
export async function startCentralIssuerService(config:CentralIssuerServiceConfig){
 if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||typeof config.serviceToken!=='string'||config.serviceToken.length<32||typeof config.preflight!=='function')throw Error('central_issuer_service_config_invalid');
 const management=localLiteLlmManagement(config.management);
 const authority=fileCentralIssuerAuthority(config.authority);
 const lite=centralLiteLlmRuntime({serviceToken:config.serviceToken,management,authority});
 const runtime=config.zuploManagementToken===undefined?lite:centralProviderRuntime(lite,centralZuploRuntime({serviceToken:config.serviceToken,management:zuploManagementHttp(config.zuploManagementToken),authority:fileCentralZuploAuthority(config.authority)}));
 await config.preflight();
 return startCentralIssuerListener(runtime,config.port);
}
