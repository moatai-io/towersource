import {redeemOutboundBootstrap} from './outbound-bootstrap-client.js';
import {setTimeout as delay} from 'node:timers/promises';
import {queryOne} from '../../db/pg-repo.js';
import {getPgPool} from '../../db/pg.js';
import {loadOutboundStartupConfig} from './outbound-startup-config.js';
import {createInstalledCustomerDelivery} from './customer-delivery-route.js';
import {outboundLocalApproval} from './outbound-local-approval.js';
import {outboundVaultPorts} from './outbound-vault-ports.js';
import {outboundEnrollmentClient} from './outbound-enrollment-client.js';
import {outboundDurableSmoke} from './outbound-durable-smoke.js';
import {outboundAiReportClient} from './outbound-ai-report-client.js';
import {runOutboundCustomer} from './outbound-customer-runner.js';
export async function startOutboundCustomerStartup(env:NodeJS.ProcessEnv,postgresReady:boolean){
 const loaded=loadOutboundStartupConfig(env);if(!loaded)return undefined;if(!postgresReady)throw Error('outbound_startup_database_missing');
 const {config,credential}=loaded;
 const groups={zuplo:createInstalledCustomerDelivery(config.deliveryPolicyFiles.zuplo,()=>credential,()=>env.TOWER_INSTANCE_ID||'','outbound'),litellm:createInstalledCustomerDelivery(config.deliveryPolicyFiles.litellm,()=>credential,()=>env.TOWER_INSTANCE_ID||'','outbound')};
 for(const provider of ['zuplo','litellm'] as const){const group=groups[provider],target=config.installed.deliveries.find(d=>d.provider===provider)!;const a=group.approved;
 if(a.providerKind!==provider||a.customerId!==config.customerId||a.instanceId!==config.installed.instanceId||a.approvalHash!==config.installed.approvalHash||a.intentId!==target.intentId||a.policyHash!==target.policyHash||a.credentialId!==target.credentialId)throw Error('outbound_startup_policy_mismatch');}
 const check=async()=>{loaded.assertCurrent();for(const g of Object.values(groups)){g.assertInstalled();const binding=await g.authority.readRuntimeBinding();await g.authority.authorize({customerId:g.approved.customerId,instanceId:g.approved.instanceId,approvalHash:g.approved.approvalHash,providerKind:g.approved.providerKind,operation:'enrollment-issue',intentId:g.approved.intentId,binding});}};
 await check();const binding=await groups.litellm.authority.readRuntimeBinding();
 const resolve=outboundLocalApproval(async()=>{await check();return config.installed;});
 const byProvider={zuplo:outboundVaultPorts({resolve,receiver:groups.zuplo.receiver}),litellm:outboundVaultPorts({resolve,receiver:groups.litellm.receiver})};
 const delivery=outboundEnrollmentClient({baseUrl:config.baseUrl,credential,instanceId:config.installed.instanceId,organizationId:config.installed.organizationId},{authorize:d=>byProvider[d.binding.provider].authorize(d),readStored:d=>byProvider[d.binding.provider].readStored(d),storeAndVerify:d=>byProvider[d.binding.provider].storeAndVerify(d)});
 const durable=outboundDurableSmoke(getPgPool(),{customerId:config.customerId,instanceId:config.installed.instanceId,approvalHash:config.installed.approvalHash,executionHash:config.installed.approvalHash,intentId:config.aiIntentId,binding},groups.litellm.createSmokePorts());
 const report=outboundAiReportClient({baseUrl:config.baseUrl,credential,executionId:config.installed.executionId,executionHash:config.installed.approvalHash,instanceId:config.installed.instanceId},{assertCurrent:async()=>{await check();await durable.assertCurrent();},readResult:durable.readResult});
 const controller=new AbortController();
 const done=(async()=>{await check();try{await delivery.tick(controller.signal);}catch(firstError){if(!(firstError instanceof Error)||firstError.message!=='outbound_delivery_auth_denied')throw firstError;await redeemOutboundBootstrap({baseUrl:config.baseUrl,bootstrapToken:loaded.bootstrapToken,credential,organizationId:config.installed.organizationId,instanceId:config.installed.instanceId},controller.signal);}return runOutboundCustomer({delivery,report,assertCurrent:check,credentialsReady:async()=>{for(const g of Object.values(groups)){if(!await queryOne('SELECT id FROM workspace_credentials WHERE id=$1',[g.approved.credentialId]))return false;const r=await g.receiver.readback(g.approved);if(!r?.stored)return false;}return true;},ensureDurableSmoke:durable.ensureDurableSmoke,wait:async(ms,signal)=>{await delay(ms,undefined,{signal});},signal:controller.signal,maxAttempts:120,deadlineMs:600000});})().then(()=>({status:'reported' as const}),()=>({status:'stopped' as const}));
 return {done,async close(){controller.abort();await done;}};
}
