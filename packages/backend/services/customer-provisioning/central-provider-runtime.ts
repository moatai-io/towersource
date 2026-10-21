import type {CentralRelayHttpConfig} from './central-relay-http.js';
/** One authenticated listener, provider-specific exact approval files and intent journals. */
export function centralProviderRuntime(litellm:CentralRelayHttpConfig,zuplo:CentralRelayHttpConfig):CentralRelayHttpConfig{
 if(litellm.serviceToken!==zuplo.serviceToken)throw Error('central_provider_token_mismatch');
 const select=(kind:string)=>{if(kind==='litellm')return litellm;if(kind==='zuplo')return zuplo;throw Error('central_provider_denied');};
 return {serviceToken:litellm.serviceToken,contractFor:(h,k)=>select(k).contractFor(h,k),ports:{
 authorizeContract:(h,i)=>select(i.providerKind).ports.authorizeContract(h,i),
 attest:c=>select(c.providerKind).ports.attest(c),
 consumeRelayIntent:(h,i)=>select(i.providerKind).ports.consumeRelayIntent(h,i),
 issueAndDeliver:(c,i)=>{if(c.providerKind!==i.providerKind)throw Error('central_provider_contract_mismatch');return select(i.providerKind).ports.issueAndDeliver(c,i);},
 }};
}
