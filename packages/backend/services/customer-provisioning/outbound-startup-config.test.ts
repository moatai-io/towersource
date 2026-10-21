import {it,expect} from 'vitest';import {parseOutboundStartupConfig,loadOutboundStartupConfig} from './outbound-startup-config.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fixture=()=>({schemaVersion:1,expiresAt:'2099-01-01T00:00:00Z',baseUrl:'https://cp.fixture',credentialFile:'/root/enrollment/credential',bootstrapTokenFile:'/root/enrollment/bootstrap',customerId:'moatai',deliveryPolicyFiles:{zuplo:'/root/zuplo.json',litellm:'/root/litellm.json'},aiIntentId:id(9),installed:{organizationId:id(1),instanceId:id(2),executionId:id(3),approvalHash:'a'.repeat(64),deliveries:[{deliveryId:id(4),intentId:id(5),provider:'zuplo',policyHash:'b'.repeat(64),credentialId:'gateway'},{deliveryId:id(6),intentId:id(7),provider:'litellm',policyHash:'c'.repeat(64),credentialId:'inference'}]}});
it('accepts exact instance-bound two-provider contract without mutating input',()=>{const x=fixture();expect(parseOutboundStartupConfig(x,id(2))).toEqual(x);expect(loadOutboundStartupConfig({})).toBeUndefined();});
it('rejects mismatched identity, expiry, destinations, duplicate intents and legacy mode',()=>{
 for(const patch of [{schemaVersion:2},{extra:true},{expiresAt:'2000-01-01'},{baseUrl:'http://cp.fixture'},{baseUrl:'https://user:pass@cp.fixture'},{credentialFile:'/root/../credential'}])expect(()=>parseOutboundStartupConfig({...fixture(),...patch},id(2))).toThrow();
 expect(()=>parseOutboundStartupConfig(fixture(),id(8))).toThrow();
 const x=fixture();x.installed.deliveries[1].intentId=x.aiIntentId;expect(()=>parseOutboundStartupConfig(x,id(2))).toThrow();
 const y=fixture();y.installed.deliveries[1].credentialId='gateway';expect(()=>parseOutboundStartupConfig(y,id(2))).toThrow();
 expect(()=>loadOutboundStartupConfig({TOWER_CUSTOMER_OUTBOUND_CONFIG:'/not-read',TOWER_CUSTOMER_SERVICE_CONFIG:'/legacy'})).toThrow('legacy_conflict');
});
