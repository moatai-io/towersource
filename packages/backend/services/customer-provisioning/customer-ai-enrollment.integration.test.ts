import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({file:{} as any,key:'',configureCount:0,activate:vi.fn(),store:vi.fn(),load:vi.fn(),save:vi.fn(),secret:vi.fn()}));
vi.mock('../../config.js',()=>({loadModelsFile:m.load,saveModelsFile:m.save}));
vi.mock('../secret/secret-store.js',()=>({getSecret:vi.fn(async()=>m.key),setSecret:m.secret}));
vi.mock('../credential-vault/credential-vault-service.js',()=>({upsertApiKeyCredential:m.store}));
vi.mock('./local-vault-access.js',()=>({assertCustomerLocalVaultAccess:vi.fn()}));
import {customerVaultReceiver} from './customer-vault-receiver.js';
import {assertCustomerLiteLLMBinding} from '../ai/litellm-setup.js';
import {handleCustomerDeliveryHttp} from './customer-delivery-http.js';
import {customerDeliveryTransport} from './central-http-delivery.js';
import {handleCustomerEnrollmentHttp} from './enrollment-http.js';
import {liteLlmEnrollmentPorts} from './litellm-enrollment-ports.js';
import type {ApprovedDelivery} from './central-delivery.js';
import type {AutoLiteLlmEnrollmentPolicy} from './litellm-auto-enrollment.js';
const token='fixture-token-'.repeat(4);
const input:ApprovedDelivery={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'litellm',credentialId:'fixture-inference'};
const b={customerId:input.customerId,instanceId:input.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:7};
const policy:AutoLiteLlmEnrollmentPolicy={customerId:input.customerId,instanceId:input.instanceId,approvalHash:input.approvalHash,policyHash:input.policyHash,credentialId:input.credentialId,teamId:'fixture-team',teamAlias:'Fixture',keyAlias:'fixture-vm-key',models:['gpt-6.1-sol','~deepseek/deepseek-pro-latest','z-ai/glm-5.3'],monthlyBudgetUsd:50,budgetDuration:'30d'};
const metadata={customer_id:input.customerId,instance_id:input.instanceId,approval_hash:input.approvalHash,policy_hash:input.policyHash};
const virtualKey='synthetic-virtual-only';
function fixture(options:{probeFailure?:boolean;saveFailure?:boolean;activateFailure?:boolean}={}){
 let teamCreated=0,keyCreated=0,issuerConsumed=false,receiverConsumed=false,serviceConsumed=false;let stored:any;const actualSecretName='VAULT_'+'A'.repeat(56);
 const team={team_id:policy.teamId,team_alias:policy.teamAlias,models:policy.models,max_budget:50,budget_duration:'30d',metadata};
 const management={async request(path:string,_method:string,body?:object){
  if(path==='/team/list')return [];
  if(path==='/models')return {data:policy.models.map(id=>({id}))};
  if(path==='/team/new'){teamCreated++;expect(body).toMatchObject(team);return team;}
  if(path.startsWith('/team/info'))return {team_info:team};
  if(path.startsWith('/key/list')){const keys=keyCreated?[{key_alias:policy.keyAlias,team_id:policy.teamId,models:policy.models,max_budget:50,budget_duration:'30d',metadata:{...metadata,credential_id:policy.credentialId}}]:[];return {keys,total_count:keys.length,total_pages:1,current_page:1};}
  if(path==='/key/generate'){keyCreated++;return {key:virtualKey,key_alias:policy.keyAlias,team_id:policy.teamId};}
  throw Error('unexpected management path');
 }};
 const receiver=customerVaultReceiver({
  async resolve(x){expect(x).toMatchObject(input);return b;},
  async assertDestinationAbsent(){if(stored)throw Error('destination_conflict');},
  async consume(){if(receiverConsumed)throw Error('replay');receiverConsumed=true;},
  async secretReference(){return actualSecretName;},async readback(x){if(!stored)throw Error('missing');assertCustomerLiteLLMBinding({baseUrl:'https://router.fixture/v1',secretName:actualSecretName});return {...x,providerResourceId:policy.keyAlias,stored:true};},
 },{async access(){},async store(x){m.store(x);stored=x;m.key=x.secretValue;return {secret_name:actualSecretName} as any;},async activate(){m.activate();if(options.activateFailure)throw Error('private-activation-failure');}},{async approvedBaseUrl(){return 'https://router.fixture/v1';}});
 vi.stubGlobal('fetch',vi.fn(async(url:any,init?:RequestInit)=>{
  if(String(url)==='https://router.fixture/v1/models'){
   expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+virtualKey);
   return options.probeFailure?new Response('private-cloudflare-response',{status:403}):Response.json({data:policy.models.map(id=>({id,model_info:{max_input_tokens:1048576,max_output_tokens:65536}}))});
  }
  return handleCustomerDeliveryHttp(new Request(url,init),{serviceToken:token,ports:receiver});
 }));
 if(options.saveFailure)m.save.mockImplementation(()=>{throw Error('disk-full');});
 const transport=customerDeliveryTransport({baseUrl:'https://receiver.fixture',serviceToken:token});
 const ports=liteLlmEnrollmentPorts({async approved(request){expect(request.approvalHash).toBe(input.approvalHash);return {delivery:input,policy};}},management,{
  ...transport,async consumeAndVerifyReceiver(x){if(issuerConsumed)throw Error('replay');await receiver.verifyLocalAuthority(x);issuerConsumed=true;},
 });
 const authority={async readRuntimeBinding(){return b;},async authorize(request:any){if(request.approvalHash!==input.approvalHash)throw Error('approval');},async consumeIntent(){if(serviceConsumed)throw Error('replay');serviceConsumed=true;}};
 return {config:{serviceToken:token,authority,ports},counts:()=>({teamCreated,keyCreated,issuerConsumed,receiverConsumed,serviceConsumed}),stored:()=>stored};
}
const request=(operation='enrollment-issue')=>new Request('https://central.fixture/v1/enrollment',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({customerId:input.customerId,instanceId:input.instanceId,approvalHash:input.approvalHash,operation,providerKind:'litellm',...(operation==='enrollment-issue'?{intentId:input.intentId}:{})})});
beforeEach(()=>{vi.resetAllMocks();m.key='';m.file={claude:[],pi:[],defaults:{session:'unconfigured'}};m.load.mockImplementation(()=>m.file);m.save.mockImplementation(x=>{m.file=structuredClone(x);});});
describe('enrollment HTTP → central Team/key → customer Vault → inference defaults',()=>{
 it('completes the real composed local call path and returns only a secret-free receipt',async()=>{
  const f=fixture();const r=await handleCustomerEnrollmentHttp(request(),f.config);expect(r.status).toBe(200);const result=await r.json();expect(result).toEqual({customerId:input.customerId,instanceId:input.instanceId,providerKind:'litellm',credentialId:input.credentialId,policyHash:input.policyHash,providerResourceId:policy.keyAlias,stored:true});
  expect(f.counts()).toMatchObject({teamCreated:1,keyCreated:1,issuerConsumed:true,receiverConsumed:true});
  expect(f.stored().defaultEnvName).toBe('LITELLM_API_KEY');expect(m.secret).not.toHaveBeenCalled();expect(m.activate).toHaveBeenCalledOnce();
  expect(m.file.customerAiBootstrap.coreModel).toBe('litellm-responses/~deepseek/deepseek-pro-latest');expect(m.file.customerAiBootstrap.liteModel).toBe(m.file.customerAiBootstrap.coreModel);
  expect(JSON.stringify(result)+JSON.stringify(m.file)).not.toContain(virtualKey);
  m.file.defaults.session='operator-choice';const read=await handleCustomerEnrollmentHttp(request('enrollment-readback'),f.config);expect(read.status).toBe(200);expect(m.file.defaults.session).toBe('operator-choice');expect(f.counts().keyCreated).toBe(1);
  expect((await handleCustomerEnrollmentHttp(request(),f.config)).status).toBe(403);expect(f.counts().keyCreated).toBe(1);
 });
 it.each([{probeFailure:true},{saveFailure:true},{activateFailure:true}])('requires recovery, not reissuance on post-Vault failure %j',async options=>{
  const f=fixture(options);const r=await handleCustomerEnrollmentHttp(request(),f.config);expect(r.status).toBe(502);expect(await r.json()).toEqual({error:'customer_enrollment_outcome_unknown'});
  expect(f.stored()).toBeTruthy();expect(f.counts()).toMatchObject({keyCreated:1,receiverConsumed:true});
  expect((await handleCustomerEnrollmentHttp(request(),f.config)).status).toBe(403);expect(f.counts().keyCreated).toBe(1);
 });
});
it('readback cannot conceal a failed model runtime activation',async()=>{
 const f=fixture({activateFailure:true});expect((await handleCustomerEnrollmentHttp(request(),f.config)).status).toBe(502);expect((await handleCustomerEnrollmentHttp(request('enrollment-readback'),f.config)).status).toBe(502);expect(f.counts().keyCreated).toBe(1);
});
