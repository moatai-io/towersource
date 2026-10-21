import fs from 'node:fs';
import {startOutboundCustomerStartup} from './outbound-customer-startup.js';
import {fetchLiteLLMTurnSpend} from '../ai-usage/litellm-turn-spend-client.js';
import {redeemOutboundBootstrap} from './outbound-bootstrap-client.js';
import {issueApprovedZuploKey} from './zuplo-key-issuer.js';
import {autoEnrollApprovedLiteLlmCustomer} from './litellm-auto-enrollment.js';
import {runOutboundCustomer} from './outbound-customer-runner.js';
import {outboundDurableSmoke} from './outbound-durable-smoke.js';
import {outboundAiReportClient} from './outbound-ai-report-client.js';
import {consumeCustomerIntent} from './pg-intent-store.js';import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
import {customerLiteLlmSmokePorts} from './litellm-smoke-ports.js';import {pgCustomerSmokeLedger} from './pg-smoke-ledger.js';
import {configureCustomerLiteLLMFromVault,assertCustomerLiteLLMBinding,activateCustomerLiteLLMRuntime} from '../ai/litellm-setup.js';import {resolveLiteLLMCredentials} from '../ai/litellm-credentials.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
import {readCustomerVaultDelivery} from './customer-vault-readback.js';
import {spawn} from 'node:child_process';
import {it,expect,vi} from 'vitest';import {Pool} from 'pg';import {readFile} from 'node:fs/promises';import net from 'node:net';import {createHash,randomBytes} from 'node:crypto';
const state=vi.hoisted(()=>({pool:null as any,models:{claude:[],pi:[]} as any,reloads:0,engineReloads:0}));vi.mock('../../db/pg.js',()=>({getPgPool:()=>state.pool}));vi.mock('../../db/pg-repo.js',()=>({queryOne:async(s:string,v:any[])=> (await state.pool.query(s,v)).rows[0]??null,query:async(s:string,v:any[])=>(await state.pool.query(s,v)).rows,execute:async(s:string,v:any[])=>{await state.pool.query(s,v);}}));
vi.mock('../../config.js',async original=>{const actual=await original<any>();const {randomBytes}=await import('node:crypto');return {...actual,loadModelsFile:()=>state.models,saveModelsFile:(x:any)=>{state.models=structuredClone(x);},reloadModels:()=>{state.reloads++;},config:{...actual.config,sandbox:{...actual.config.sandbox,secretStoreMasterKey:randomBytes(32).toString('hex')}}};});
vi.mock('../../engines/index.js',()=>({getEngine:async()=>({reloadModelRegistry:async()=>{state.engineReloads++;}})}));
import {upsertApiKeyCredential} from '../credential-vault/credential-vault-service.js';import {getSecretForProjectBinding} from '../secret/secret-store.js';
import {customerVaultReceiver} from './customer-vault-receiver.js';import {assertCustomerVaultDestinationAbsent} from './customer-vault-readback.js';import {consumeOutboundDeliveryIntent} from './pg-outbound-delivery-intent.js';import {outboundLocalApproval} from './outbound-local-approval.js';import {outboundVaultPorts} from './outbound-vault-ports.js';import {outboundEnrollmentClient} from './outbound-enrollment-client.js';import {applyCustomerGatewaySetup,preflightCustomerGatewaySetup,verifyCustomerGatewaySetup} from './customer-gateway-setup.js';
const url=process.env.OUTBOUND_CUSTOMER_TEST_DATABASE_URL;
it.skipIf(!url)('outbound fetch -> real local approval -> canonical encrypted Vault/Profile -> ACK loss/reuse, no customer listener',async()=>{
 const pool=new Pool({connectionString:url});state.pool=pool;
 const cpRoot=process.env.OUTBOUND_CP_SOURCE;const cpUrl=process.env.TEST2_LOCAL_DATABASE_URL;
 const bundlePath=process.env.OUTBOUND_ISSUER_BUNDLE;
 const bundle=bundlePath?await import(/* @vite-ignore */ bundlePath):null;
 const cp=cpRoot&&cpUrl?await (await import(/* @vite-ignore */ cpRoot+'/scripts/outbound-cp-http-fixture.ts')).startOutboundCpFixture(cpUrl,async(approved:any,policy:any)=>{let creates=0;const original=globalThis.fetch;
 let result;
 if(bundle){
 globalThis.fetch=async(url,init)=>{expect(String(url)).toMatch(/^https:\/\/dev\.zuplo\.com\//);if(init?.method==='POST'){creates++;const body=JSON.parse(String(init.body));expect(body.metadata.delivery_intent_id).toBe(approved.intentId);return Response.json({id:'fixture-resource',name:policy.consumerName,apiKeys:[{key:'synthetic-outbound-key'}]});}return Response.json({offset:0,limit:100,data:[]});};
 try{const issuer=bundle.centralOutboundIssuers({litellm:{baseUrl:'http://127.0.0.1:4000',masterKey:'x'.repeat(40)},zuplo:'synthetic-zuplo-token'});result=await issuer.issueZuplo(approved,policy);}finally{globalThis.fetch=original;}
 }else result=await issueApprovedZuploKey(approved,policy,{async consumerExists(){return false;},async createConsumer(input){creates++;return {id:'fixture-resource',name:input.name,apiKeys:[{key:'synthetic-outbound-key'}]};}});
 expect(creates).toBe(1);return result;}):null;
 if(cp){expect(await redeemOutboundBootstrap({baseUrl:'https://fixture.invalid',bootstrapToken:cp.bootstrapToken,credential:cp.machine,organizationId:cp.binding.organizationId,instanceId:cp.binding.instanceId},new AbortController().signal,async(input,init)=>fetch('http://127.0.0.1:'+cp.port+new URL(String(input)).pathname,init))).toEqual({registered:true});}
 const policy=cp?.gatewayPolicy??{profileVersion:'1',enabledApiIds:['naver'],quotaMode:'observe' as const};const hash=cp?.binding.policyHash??createHash('sha256').update(JSON.stringify({enabledApiIds:['naver'],profileVersion:'1',quotaMode:'observe'})).digest('hex');

 const d=cp?.approved??{intentId:'11111111-1111-4111-8111-111111111111',instanceId:'22222222-2222-4222-8222-222222222222',customerId:'fixture',approvalHash:'a'.repeat(64),policyHash:hash,providerKind:'zuplo' as const,credentialId:'gateway'},b={smokeModel:'gpt-6.1-sol',customerId:d.customerId,instanceId:d.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:1};const setup={profileId:'tower-shared-api-v1',gatewayBaseUrl:'https://fixture.example/',policy};
 const realFetch=globalThis.fetch;vi.stubGlobal('fetch',async(url:any,init:any)=>{if(String(url)==='https://router.fixture/v1/models'){expect(init.headers.Authorization).toBe('Bearer synthetic-outbound-lite-key');return Response.json({data:[{id:'gpt-6.1-sol'}]});}return realFetch(url,init);});
 try{
 await pool.query('CREATE TABLE users(id bigint PRIMARY KEY,role text,disabled integer,approval_status text);CREATE TABLE projects(id uuid PRIMARY KEY);CREATE TABLE project_members(project_id uuid,user_id bigint,role text);CREATE TABLE workspace_credentials(id text PRIMARY KEY,kind text,provider text,display_name text,secret_name text,default_env_name text,scope text,project_id uuid,enabled boolean DEFAULT true,metadata jsonb,rotated_at timestamptz,created_by bigint,updated_by bigint,updated_at timestamptz DEFAULT now())');
 await pool.query(`CREATE TABLE secret_grants(secret_id bigint,user_id bigint);CREATE TABLE credential_audit_events(id bigserial,credential_id text,project_id uuid,event_type text,actor_user_id bigint,provider text,target_type text,target_ref jsonb,status text,error_code text,message text);CREATE TABLE secret_store(id bigserial PRIMARY KEY,name text,value_encrypted bytea,scope text,owner_user_id bigint,owner_tool_id text,description text,created_by bigint,rotated_at timestamptz);`);
 await pool.query(await readFile(new URL('./intent-schema.candidate.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('./locked-approval.candidate.sql',import.meta.url),'utf8'));
 await pool.query("CREATE ROLE fixture_customer_limited NOLOGIN; GRANT USAGE ON SCHEMA public TO fixture_customer_limited; GRANT SELECT ON customer_runtime_approvals TO fixture_customer_limited; GRANT EXECUTE ON FUNCTION public.lock_customer_runtime_approval(text,text,uuid,uuid,bigint,text) TO fixture_customer_limited");await pool.query(await readFile(new URL('../../db/migrations/211_gateway_profiles.sql',import.meta.url),'utf8'));if(cp)await pool.query(await readFile(new URL('./gateway-corepin-seed.candidate.sql',import.meta.url),'utf8'));
 await pool.query("INSERT INTO users VALUES(1,'admin',0,'active');INSERT INTO projects VALUES('33333333-3333-4333-8333-333333333333')");
 await pool.query("INSERT INTO customer_runtime_approvals VALUES($1,$2,$3,$4,1,ARRAY['enrollment-issue','enrollment-readback','smoke-execute'],now()+interval '1 hour',false)",[d.approvalHash,d.customerId,d.instanceId,b.projectId]);
 await pool.query("INSERT INTO customer_service_intents VALUES($1,$2,$3,$4,'enrollment-issue','zuplo',$5,1,now()+interval '1 hour',false,NULL)",[d.intentId,d.customerId,d.instanceId,d.approvalHash,b.projectId]);await pool.query('INSERT INTO customer_delivery_intents VALUES($1,$2,$3,NULL)',[d.intentId,hash,d.credentialId]);

 const deliveryId=cp?.binding.deliveryId??'44444444-4444-4444-8444-444444444444',executionId=cp?.binding.executionId??'55555555-5555-4555-8555-555555555555',organizationId=cp?.binding.organizationId??'66666666-6666-4666-8666-666666666666';
 const installed={organizationId,instanceId:d.instanceId,executionId,approvalHash:d.approvalHash,deliveries:[{deliveryId,intentId:d.intentId,provider:'zuplo' as const,policyHash:hash,credentialId:d.credentialId}]};
 const delivery={status:'available',deliveryId,binding:{organizationId,instanceId:d.instanceId,executionId,intentId:d.intentId,deliveryId,provider:'zuplo',policyHash:hash,expiresAt:new Date(Date.now()+60000).toISOString()},providerResourceId:'csmr_fixture',value:'synthetic-outbound-key'};
 const resolve=outboundLocalApproval(async()=>installed);
 const restricted=await pool.connect();try{await restricted.query('BEGIN');await restricted.query('SET LOCAL ROLE fixture_customer_limited');
 expect((await restricted.query('SELECT public.lock_customer_runtime_approval($1,$2,$3,$4,$5,$6)',[d.approvalHash,d.customerId,d.instanceId,b.projectId,1,'enrollment-issue'])).rowCount).toBe(1);await restricted.query('ROLLBACK');
 await restricted.query('BEGIN');await restricted.query('SET LOCAL ROLE fixture_customer_limited');await expect(restricted.query('UPDATE customer_runtime_approvals SET revoked=false')).rejects.toThrow();await restricted.query('ROLLBACK');
 }finally{restricted.release();}
 const receiver=customerVaultReceiver({resolve:async()=>b,assertDestinationAbsent:assertCustomerVaultDestinationAbsent,consume:(i,b)=>consumeOutboundDeliveryIntent(pool,i,b),readback:readCustomerVaultDelivery},undefined,undefined,{preflight:i=>preflightCustomerGatewaySetup(i,setup),apply:(i,b,r)=>applyCustomerGatewaySetup(i,b,r,setup),verify:(i,b,r)=>verifyCustomerGatewaySetup(i,b,r,setup)});
 let completed=false,ackCalls=0;
 const client=outboundEnrollmentClient({baseUrl:'https://cp.fixture',credential:cp?.machine??'a'.repeat(43),instanceId:d.instanceId,organizationId},outboundVaultPorts({resolve,receiver}),async(url,init)=>{
 if(cp)return fetch('http://127.0.0.1:'+cp.port+new URL(String(url)).pathname,init);
 if(String(url).endsWith('/next'))return Response.json(completed?{status:'idle'}:delivery);
 ackCalls++;if(ackCalls===1)throw Error('fixture ACK request lost');const x=JSON.parse(String(init?.body));expect(x.receipt.providerResourceId).toBe('csmr_fixture');completed=true;return Response.json(x.receipt);
 });
 await expect(client.tick(new AbortController().signal)).rejects.toThrow();
 if(cp){expect(await client.tick(new AbortController().signal)).toEqual({status:'idle'});await cp.assertComplete();}else expect((await client.tick(new AbortController().signal))).toMatchObject({status:'acknowledged',reused:true});expect(await client.tick(new AbortController().signal)).toEqual({status:'idle'});

 if(cp){
 const ld=cp.liteApproved,lb=cp.liteBinding;
 await pool.query("INSERT INTO customer_service_intents VALUES($1,$2,$3,$4,'enrollment-issue','litellm',$5,1,now()+interval '1 hour',false,NULL)",[ld.intentId,ld.customerId,ld.instanceId,ld.approvalHash,b.projectId]);await pool.query('INSERT INTO customer_delivery_intents VALUES($1,$2,$3,NULL)',[ld.intentId,ld.policyHash,ld.credentialId]);
 const liteInstalled={...installed,deliveries:[{deliveryId:lb.deliveryId,intentId:ld.intentId,provider:'litellm' as const,policyHash:ld.policyHash,credentialId:ld.credentialId}]};
 let configured='',activations=0;
 const liteReceiver=customerVaultReceiver({resolve:async()=>b,assertDestinationAbsent:assertCustomerVaultDestinationAbsent,consume:(i,b)=>consumeOutboundDeliveryIntent(pool,i,b),readback:readCustomerVaultDelivery,secretReference:async()=>configured},
 {access:assertCustomerLocalVaultAccess,store:upsertApiKeyCredential,configure:async x=>{configured=x.secretName;return configureCustomerLiteLLMFromVault(x);},verify:assertCustomerLiteLLMBinding,activate:async()=>{await activateCustomerLiteLLMRuntime();activations++;}},
 {approvedBaseUrl:async()=> 'https://router.fixture/v1',approvedProfile:async()=> 'gpt-only'});
 const liteClient=outboundEnrollmentClient({baseUrl:'https://cp.fixture',credential:cp.machine,instanceId:d.instanceId,organizationId},outboundVaultPorts({resolve:outboundLocalApproval(async()=>liteInstalled),receiver:liteReceiver}),async(url,init)=>fetch('http://127.0.0.1:'+cp.port+new URL(String(url)).pathname,init));
 await cp.publishLite(async(approved:any,policy:any)=>{
 let team:any=null,key:any=null,teamPosts=0,keyPosts=0;
 const management={async request(path:string,method:string,body?:any){
 if(path==='/models')return {data:policy.models.map((id:string)=>({id}))};
 if(path==='/team/list')return team?[team]:[];
 if(path==='/team/new'){teamPosts++;team={...body,blocked:false};return team;}
 if(path.startsWith('/team/info?'))return {team_info:team};
 if(path.startsWith('/key/list?'))return {keys:key?[key]:[],total_count:key?1:0,total_pages:1};
 if(path==='/key/generate'){keyPosts++;key={...body,blocked:false};return {key:'synthetic-outbound-lite-key',team_id:policy.teamId,key_alias:policy.keyAlias};}
 throw Error('unexpected_fixture_management_path');
 }};
 let result;const prior=globalThis.fetch;
 if(bundle){const issuer=bundle.centralOutboundIssuers({litellm:{baseUrl:'http://127.0.0.1:4000',masterKey:'x'.repeat(40)},zuplo:'synthetic-zuplo-token'});globalThis.fetch=async(url,init)=>{const u=new URL(String(url));expect(u.origin).toBe('http://127.0.0.1:4000');return Response.json(await management.request(u.pathname+u.search,init?.method??'GET',init?.body?JSON.parse(String(init.body)):undefined));};try{result=await issuer.issueLiteLlm(approved,policy);}finally{globalThis.fetch=prior;}}else result=await autoEnrollApprovedLiteLlmCustomer(approved,policy,management);
 expect(teamPosts).toBe(1);expect(keyPosts).toBe(1);expect(key.metadata.credential_id).toBe(approved.credentialId);expect(result.providerResourceId).toBe(policy.keyAlias);return result;
 });expect(await liteClient.tick(new AbortController().signal)).toMatchObject({status:'acknowledged',reused:false});expect(await liteClient.tick(new AbortController().signal)).toEqual({status:'idle'});await cp.assertComplete();
 expect(await getSecretForProjectBinding(configured)).toBe('synthetic-outbound-lite-key');expect(activations).toBe(1);expect(state.reloads).toBe(1);expect(state.engineReloads).toBe(1);expect((await resolveLiteLLMCredentials()).apiKey).toBe('synthetic-outbound-lite-key');expect(state.models.defaults).toMatchObject({session:'litellm-responses/gpt-6.1-sol',ai_task:'litellm-responses/gpt-6.1-sol',ai_reply:'litellm-responses/gpt-6.1-sol'});expect(state.models.pi.filter((x:any)=>x.enabled&&!x.hidden).map((x:any)=>x.modelId)).toEqual(['gpt-6.1-sol']);
 const aiIntent=cp.aiIntent;let aiCalls=0;
 await pool.query(await readFile(new URL('./smoke-ledger.candidate.sql',import.meta.url),'utf8'));
 await pool.query("ALTER TABLE customer_runtime_approvals ADD COLUMN smoke_model text;UPDATE customer_runtime_approvals SET smoke_model='gpt-6.1-sol';CREATE FUNCTION public.lock_customer_smoke_model(p_hash text,p_instance uuid,p_model text) RETURNS SETOF text LANGUAGE sql AS $$SELECT smoke_model FROM customer_runtime_approvals WHERE approval_hash=p_hash AND instance_id=p_instance AND revoked=false AND expires_at>clock_timestamp() AND smoke_model=p_model FOR SHARE$$");
 await pool.query("INSERT INTO customer_service_intents VALUES($1,$2,$3,$4,'smoke-execute',NULL,$5,1,now()+interval '1 hour',false,NULL)",[aiIntent,d.customerId,d.instanceId,d.approvalHash,b.projectId]);
 await pool.query('INSERT INTO customer_smoke_budgets(instance_id,team_observed_microusd,team_observed_at) VALUES($1,0,now())',[d.instanceId]);
 const ledger=pgCustomerSmokeLedger(pool,{instanceId:d.instanceId,approvalHash:d.approvalHash,estimatedMicrousd:1000,model:'gpt-6.1-sol'});
 const smokePorts=customerLiteLlmSmokePorts(ledger,{
  async credentials(){return resolveLiteLLMCredentials();},
  async usage(){const v=await ledger.snapshot();const now=new Date().toISOString();return {source:'litellm-spendlogs' as const,scope:'team' as const,period:'calendar_month' as const,days:30,key:{},team:{},summary:{cost_usd:String(v.spendMicrousd/1000000),observed_at:now},budget_observation:{source:'litellm-team-budget' as const,spend_usd:String(v.spendMicrousd/1000000),observed_at:now},budget_window:null,daily:[],models:[],projects:[]};},
  async turnSpend(){const original=globalThis.fetch;globalThis.fetch=async(url)=>{expect(new URL(String(url)).searchParams.get('root_turn_id')).toBe(aiIntent);return Response.json({source:'litellm-spendlogs',root_turn_id:aiIntent,complete:true,rows:[{request_id:'fixture-ai-request',root_turn_id:aiIntent,spend:'0.0001',status:'success'}]});};try{return await fetchLiteLLMTurnSpend(aiIntent);}finally{globalThis.fetch=original;}},
  async fetch(_url,opts){const payload=JSON.parse(String(opts?.body));expect(payload.metadata.tower_root_turn_id).toBe(aiIntent);aiCalls++;return Response.json({id:'fixture-ai-request',model:'gpt-6.1-sol',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});}
 });

 await smokePorts.usage({} as any,b as any);const input={intentId:aiIntent,model:'gpt-6.1-sol',prompt:'Reply with exactly: TOWER_SMOKE_OK',maxOutputTokens:32};
 const durable=outboundDurableSmoke(pool,{customerId:d.customerId,instanceId:d.instanceId,approvalHash:d.approvalHash,executionHash:cp.executionHash,intentId:aiIntent,binding:b},smokePorts);
 expect(await durable.ensureDurableSmoke(new AbortController().signal)).toBe('reconciled');
 expect(await durable.ensureDurableSmoke(new AbortController().signal)).toBe('reconciled');
 const answer=(await durable.readResult())!;expect(answer.usageMicrousd).toBe(100);expect(aiCalls).toBe(1);expect((await ledger.snapshot()).requests).toBe(1);
 const report={executionHash:cp.executionHash,instanceId:d.instanceId,model:answer.model,verified:true,requestId:answer.requestId,evidenceId:aiIntent,usageMicrousd:answer.usageMicrousd};
 const sendReport=(value:unknown)=>fetch('http://127.0.0.1:'+cp.port+'/api/enrollment/ack',{method:'POST',headers:{authorization:'Bearer '+cp.machine,'content-type':'application/json'},body:JSON.stringify({kind:'ai-result',executionId:cp.executionId,report:value})});
 const reportClient=outboundAiReportClient({baseUrl:'https://fixture.invalid',credential:cp.machine,executionId:cp.executionId,executionHash:cp.executionHash,instanceId:d.instanceId},durable,async(input,init)=>fetch('http://127.0.0.1:'+cp.port+new URL(String(input)).pathname,init));
 expect(await runOutboundCustomer({delivery:liteClient,report:reportClient,assertCurrent:durable.assertCurrent,credentialsReady:async()=>{return Boolean((await resolveLiteLLMCredentials()).apiKey);},ensureDurableSmoke:durable.ensureDurableSmoke,wait:async()=>{await cp.prepareAi();},signal:new AbortController().signal,maxAttempts:2,deadlineMs:10000})).toEqual({status:'reported',verifiedByControlPlane:false});
 expect(await reportClient.tick(new AbortController().signal)).toEqual({status:'received',verifiedByControlPlane:false});
 expect(await reportClient.tick(new AbortController().signal)).toEqual({status:'received',verifiedByControlPlane:false});expect(aiCalls).toBe(1);
 expect((await sendReport(report)).status).toBe(200);
 expect((await sendReport(report)).status).toBe(200);
 expect((await sendReport({...report,usageMicrousd:101})).status).toBe(403);
 for(const mode of ['revoked','expired'] as const){await cp.setMachineState(mode);expect((await sendReport(report)).status).toBe(403);}
 await cp.setMachineState('active');expect((await sendReport(report)).status).toBe(200);
 await cp.verifyAi();await cp.verifyRateLimit();
 if(process.env.CUSTOMER_PROTECTED_STARTUP_FIXTURE==='1'){
 const dir='/etc/tower-startup-fixture';fs.mkdirSync(dir,{recursive:true,mode:0o750});fs.chownSync(dir,0,1000);
 const cred=dir+'/credentials';fs.mkdirSync(cred,{mode:0o700});fs.chownSync(cred,1000,1000);
 const write=(name:string,data:unknown)=>{const file=dir+'/'+name;fs.writeFileSync(file,JSON.stringify(data),{mode:0o640});fs.chownSync(file,0,1000);return file;};
 for(const [name,value] of [['outbound-machine',cp.machine],['outbound-bootstrap',cp.bootstrapToken]]){fs.writeFileSync(cred+'/'+name,value,{mode:0o400});fs.chownSync(cred+'/'+name,1000,1000);}
 const gatewayPolicy=write('gateway.json',{schemaVersion:1,delivery:d,inferenceBaseUrl:'https://router.fixture/v1',gatewaySetup:setup});
 const litePolicy=write('lite.json',{schemaVersion:1,delivery:ld,inferenceBaseUrl:'https://router.fixture/v1',modelPolicy:'gpt-only',smokeEstimateMicrousd:1000,smokeModel:'gpt-6.1-sol'});
 const config=write('outbound.json',{schemaVersion:1,expiresAt:new Date(Date.now()+1800000).toISOString(),baseUrl:'https://fixture.invalid',credentialFile:cred+'/outbound-machine',bootstrapTokenFile:cred+'/outbound-bootstrap',customerId:d.customerId,deliveryPolicyFiles:{zuplo:gatewayPolicy,litellm:litePolicy},aiIntentId:aiIntent,installed:{organizationId:cp.binding.organizationId,instanceId:d.instanceId,executionId:cp.executionId,approvalHash:d.approvalHash,deliveries:[cp.binding,cp.liteBinding].map((x:any)=>({deliveryId:x.deliveryId,intentId:x.intentId,provider:x.provider,policyHash:x.policyHash,credentialId:x.provider==='zuplo'?d.credentialId:ld.credentialId}))}});
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{const u=new URL(String(url));if(u.origin!=='https://fixture.invalid')throw Error('unexpected_startup_paid_or_provider_call');return original('http://127.0.0.1:'+cp.port+u.pathname,options);};
 let started:Awaited<ReturnType<typeof startOutboundCustomerStartup>>;
 try{process.setegid!(1000);process.seteuid!(1000);
 started=await startOutboundCustomerStartup({TOWER_CUSTOMER_OUTBOUND_CONFIG:config,TOWER_INSTANCE_ID:d.instanceId,CREDENTIALS_DIRECTORY:cred},true);
 expect(await started!.done).toEqual({status:'reported'});expect(aiCalls).toBe(1);await started!.close();
 process.seteuid!(0);process.setegid!(0);await cp.resetDeliveriesForFreshCustomerFixture();
 await pool.query('DELETE FROM credential_audit_events');await pool.query('DELETE FROM workspace_credentials');await pool.query('DELETE FROM secret_store');await pool.query('UPDATE gateway_profiles SET credential_id=NULL,consumer_ref=NULL');
 await pool.query('DELETE FROM customer_smoke_reservations');await pool.query('UPDATE customer_smoke_budgets SET smoke_spend_microusd=0,reserved_microusd=0');
 await pool.query('UPDATE customer_service_intents SET consumed_at=NULL WHERE id=ANY($1::uuid[])',[[d.intentId,ld.intentId,aiIntent]]);await pool.query('UPDATE customer_delivery_intents SET consumed_at=NULL');
 await pool.query(`CREATE ROLE fixture_customer_app NOLOGIN; GRANT USAGE ON SCHEMA public TO fixture_customer_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO fixture_customer_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO fixture_customer_app;
 REVOKE ALL ON customer_runtime_approvals,customer_service_intents,customer_delivery_intents,customer_smoke_budgets,customer_smoke_reservations FROM fixture_customer_app;
 GRANT SELECT ON customer_runtime_approvals,customer_service_intents,customer_delivery_intents,customer_smoke_budgets,customer_smoke_reservations TO fixture_customer_app;
 GRANT UPDATE(consumed_at) ON customer_service_intents,customer_delivery_intents TO fixture_customer_app;
 GRANT UPDATE(team_observed_microusd,team_observed_at,reserved_microusd,requests,smoke_spend_microusd) ON customer_smoke_budgets TO fixture_customer_app;
 GRANT INSERT ON customer_smoke_reservations TO fixture_customer_app;
 GRANT UPDATE(actual_microusd,request_id,reconciled_at) ON customer_smoke_reservations TO fixture_customer_app;
 GRANT EXECUTE ON FUNCTION public.lock_customer_runtime_approval(text,text,uuid,uuid,bigint,text),public.lock_customer_smoke_intent(uuid,uuid,text) TO fixture_customer_app;`);
 const appPool=new Pool({connectionString:url,options:'-c role=fixture_customer_app'});
 await expect(appPool.query('UPDATE customer_runtime_approvals SET revoked=false')).rejects.toThrow();
 await expect(appPool.query('UPDATE customer_smoke_budgets SET smoke_limit_microusd=999999999')).rejects.toThrow();
 state.pool=appPool;
 state.models={claude:[],pi:[],defaults:{session:'',ai_reply:'',ai_task:''}};let freshCalls=0;globalThis.fetch=async(url,options)=>{const u=new URL(String(url));
 if(u.origin==='https://fixture.invalid')return original('http://127.0.0.1:'+cp.port+u.pathname,options);
 if(u.origin==='https://router.fixture'&&u.pathname==='/v1/models')return Response.json({data:[{id:'gpt-6.1-sol'}]});
 if(u.origin==='https://router.fixture'&&u.pathname.endsWith('/v1/usage'))return Response.json({source:'litellm-spendlogs',scope:'team',period:'calendar_month',days:30,summary:{cost_usd:'0'},daily:[],models:[],projects:[],budget_observation:{source:'litellm-team-budget',spend_usd:'0',observed_at:new Date().toISOString()}});
 if(u.origin==='https://router.fixture'&&u.pathname.endsWith('/v1/turn-spend'))return Response.json({source:'litellm-spendlogs',root_turn_id:aiIntent,complete:true,rows:[{request_id:'fixture-ai-request',root_turn_id:aiIntent,spend:'0.0001',status:'success'}]});
 if(u.origin==='https://router.fixture'&&u.pathname==='/v1/responses'){freshCalls++;return Response.json({id:'fixture-ai-request',model:'gpt-6.1-sol',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});}
 throw Error('unexpected_fresh_startup_url');};
 process.setegid!(1000);process.seteuid!(1000);
 started=await startOutboundCustomerStartup({TOWER_CUSTOMER_OUTBOUND_CONFIG:config,TOWER_INSTANCE_ID:d.instanceId,CREDENTIALS_DIRECTORY:cred},true);
 expect(await started!.done).toEqual({status:'reported'});expect(freshCalls).toBe(1);await started!.close();
 expect((await pool.query('SELECT count(*)::int n FROM workspace_credentials')).rows[0].n).toBe(2);state.pool=pool;await appPool.end();

 }finally{process.seteuid!(0);process.setegid!(0);globalThis.fetch=original;}
 }

 const uncertain='77777777-7777-4777-8777-777777777777';
 await pool.query("INSERT INTO customer_service_intents VALUES($1,$2,$3,$4,'smoke-execute',NULL,$5,1,now()+interval '1 hour',false,now())",[uncertain,d.customerId,d.instanceId,d.approvalHash,b.projectId]);
 const unknown=outboundDurableSmoke(pool,{customerId:d.customerId,instanceId:d.instanceId,approvalHash:d.approvalHash,executionHash:cp.executionHash,intentId:uncertain,binding:b},smokePorts);
 await expect(unknown.ensureDurableSmoke(new AbortController().signal)).rejects.toThrow('outbound_smoke_outcome_unknown_no_replay');expect(aiCalls).toBe(1);
 await pool.query('UPDATE customer_runtime_approvals SET revoked=true WHERE approval_hash=$1',[d.approvalHash]);
 await expect(durable.readResult()).rejects.toThrow('customer_locked_approval_denied');expect(aiCalls).toBe(1);
 await pool.query('UPDATE customer_runtime_approvals SET revoked=false WHERE approval_hash=$1',[d.approvalHash]);



 }
 const row=(await pool.query('SELECT secret_name FROM workspace_credentials WHERE id=$1',[d.credentialId])).rows[0];expect(await getSecretForProjectBinding(row.secret_name)).toBe(delivery.value);
 expect((await pool.query('SELECT count(*)::int n FROM secret_store')).rows[0].n).toBe(cp?2:1);expect((await pool.query("SELECT count(*)::int n FROM credential_audit_events WHERE event_type='credential_created'")).rows[0].n).toBe(cp?2:1);
 expect((await pool.query('SELECT consumed_at IS NOT NULL consumed FROM customer_delivery_intents')).rows[0].consumed).toBe(true);expect((await pool.query('SELECT status FROM gateway_profiles WHERE id=$1',[setup.profileId])).rows[0].status).toBe('pending');
 }finally{vi.unstubAllGlobals();if(cp)await cp.close();await pool.end();}
},30000);
