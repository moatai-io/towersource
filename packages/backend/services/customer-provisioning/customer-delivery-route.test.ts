import fs from 'node:fs';
import express from 'express';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../../db/pg-repo.js',()=>({queryOne:vi.fn()}));
vi.mock('../../db/pg.js',()=>({getPgPool:vi.fn()}));
vi.mock('../secret/secret-store.js',()=>({getSecret:vi.fn(),setSecret:vi.fn()}));
vi.mock('../credential-vault/credential-vault-service.js',()=>({upsertApiKeyCredential:vi.fn()}));
vi.mock('./local-vault-access.js',()=>({assertCustomerLocalVaultAccess:vi.fn()}));
import {customerDeliveryExpressAdapter,createCustomerDeliveryRoute} from './customer-delivery-route.js';
import {startCustomerDeliveryListener} from './customer-delivery-listener.js';
const token='fixture-token-'.repeat(4);
const input={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'litellm' as const,credentialId:'fixture-key'};
const config=()=>({serviceToken:token,ports:{verifyLocalAuthority:vi.fn(async()=>{}),consumeDeliveryIntent:vi.fn(async()=>{}),store:vi.fn(async()=>{}),readback:vi.fn(async()=>({...input,providerResourceId:'resource-1',stored:true as const}))}});
const servers:ReturnType<typeof createServer>[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
it('mounts on a private listener with a raw bounded body and leaves other routes alone',async()=>{
 const c=config();const installed=vi.fn();const app=express();app.use(customerDeliveryExpressAdapter(c,installed));app.use((_req,res)=>res.status(404).json({error:'not_found'}));const s=createServer(app);servers.push(s);s.listen(0,'127.0.0.1');await once(s,'listening');const base=`http://127.0.0.1:${(s.address() as any).port}`;
 const r=await fetch(base+'/v1/credentials/deliver',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...input,providerResourceId:'resource-1',value:'fixture-secret'})});expect(r.status).toBe(200);expect(await r.text()).not.toContain('fixture-secret');expect(installed).toHaveBeenCalledOnce();expect(c.ports.store).toHaveBeenCalledOnce();expect((await fetch(base+'/other')).status).toBe(404);
});
it('denies non-loopback sockets without trusting a forwarded header',async()=>{
 const c=config(),installed=vi.fn();const response:any={setHeader:vi.fn(),status:vi.fn().mockReturnThis(),json:vi.fn()};let next=0;
 await customerDeliveryExpressAdapter(c,installed)({originalUrl:'/v1/credentials/deliver',socket:{remoteAddress:'198.51.100.1'},headers:{'x-forwarded-for':'127.0.0.1'}} as any,response,()=>{next++;});expect(response.status).toHaveBeenCalledWith(403);expect(installed).not.toHaveBeenCalled();expect(next).toBe(0);
});
it('does nothing on an ordinary Tower without a selected receiver policy',async()=>{const factory=vi.fn();expect(await startCustomerDeliveryListener({},false,factory)).toBeUndefined();expect(factory).not.toHaveBeenCalled();});
it('requires PostgreSQL readiness, local identity, strong token and dedicated port',async()=>{
 const env={TOWER_CUSTOMER_DELIVERY_POLICY:'/etc/tower/customer-delivery.json',TOWER_CUSTOMER_DELIVERY_PORT:'3102',TOWER_CUSTOMER_DELIVERY_TOKEN:token,TOWER_INSTANCE_ID:input.instanceId};const factory=vi.fn();await expect(startCustomerDeliveryListener(env,false,factory)).rejects.toThrow('configuration_invalid');await expect(startCustomerDeliveryListener({...env,TOWER_CUSTOMER_DELIVERY_PORT:'80'},true,factory)).rejects.toThrow('configuration_invalid');await expect(startCustomerDeliveryListener({...env,TOWER_INSTANCE_ID:'caller-name'},true,factory)).rejects.toThrow('configuration_invalid');expect(factory).not.toHaveBeenCalled();
});
it('never loads caller or relative filesystem policy paths',()=>expect(()=>createCustomerDeliveryRoute('work/customer-policy.json',()=>token,()=>input.instanceId)).toThrow('policy_invalid'));
it('installed GPT profile is explicit and invalid profiles rejected',()=>{
 const policy={schemaVersion:1,delivery:input,inferenceBaseUrl:'https://router.fixture/v1',modelPolicy:'gpt-only'};
 const stat=vi.spyOn(fs,'lstatSync').mockReturnValue({uid:0,mode:0o600,size:100,isSymbolicLink:()=>false,isFile:()=>true} as any);
 const read=vi.spyOn(fs,'readFileSync').mockReturnValue(Buffer.from(JSON.stringify(policy)));
 try{
  expect(typeof createCustomerDeliveryRoute('/etc/fixture/policy.json',()=>token,()=>input.instanceId)).toBe('function');
  read.mockReturnValue(Buffer.from(JSON.stringify({...policy,modelPolicy:'caller-selected'})));
  expect(()=>createCustomerDeliveryRoute('/etc/fixture/policy.json',()=>token,()=>input.instanceId)).toThrow('policy_invalid');
 }finally{stat.mockRestore();read.mockRestore();}
});
it('dispatches private smoke routes only through explicit installed callback',async()=>{
 const express=(await import('express')).default;const app=express();const smoke=vi.fn(async()=>Response.json({ok:true}));
 const receiver={serviceToken:token,ports:{verifyLocalAuthority:vi.fn(),consumeDeliveryIntent:vi.fn(),store:vi.fn(),readback:vi.fn()}};
 app.use(customerDeliveryExpressAdapter(receiver,()=>{},smoke));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{const port=(server.address() as any).port;const r=await fetch(`http://127.0.0.1:${port}/v1/smoke/usage`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});expect(r.status).toBe(200);expect(smoke).toHaveBeenCalledOnce();expect(smoke.mock.calls[0][1]).toBe('usage');expect((await fetch(`http://127.0.0.1:${port}/v1/smoke/other`,{method:'POST'})).status).toBe(404);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
