import net from 'node:net';
import {startCentralIssuerListener} from './central-issuer-listener.js';
import {startCustomerEnrollmentListener} from './enrollment-listener.js';
import {it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({preflight:vi.fn(),deliver:vi.fn(),readback:vi.fn()}));vi.mock('./central-http-delivery.js',()=>({customerDeliveryTransport:()=>m}));
import {customerRelayEnrollmentPorts} from './customer-relay-enrollment-ports.js';import {centralZuploRuntime} from './central-zuplo-runtime.js';import {handleCentralRelayHttp} from './central-relay-http.js';import {centralRelayContractHash} from './central-relay.js';import {runCustomerEnrollmentService} from './enrollment-handler.js';
it('customer request -> authenticated central relay -> create -> customer store/readback; replay denied',async()=>{
 const token='fixture-token-'.repeat(4);const delivery={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'zuplo' as const,credentialId:'gateway'};
 const {intentId:deliveryIntent,...contractFields}=delivery;const contract={...contractFields,authorityId:'fixture',revision:'c'.repeat(40),issuerRuntimeId:'central',receiverRuntimeId:'customer'};const binding={customerId:delivery.customerId,instanceId:delivery.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:1};const receipt={...delivery,providerResourceId:'csmr_fixture',stored:true as const};let stored=false,consumed=false,centralConsumed=false;const create=vi.fn(async()=>({id:'csmr_fixture',name:'vm-fixture',apiKeys:[{key:'synthetic-only'}]}));
 m.preflight.mockImplementation(async()=>{if(stored)throw Error('already stored');});m.deliver.mockImplementation(async x=>{expect(x.value).toBe('synthetic-only');stored=true;return receipt;});m.readback.mockImplementation(async()=>{if(!stored)throw Error('absent');return receipt;});
 const central=centralZuploRuntime({serviceToken:token,management:{consumerExists:async()=>false,createConsumer:create},authority:{contractFor:async()=>contract,authorizeContract:async()=>{},attest:async()=>{},consumeRelayIntent:async()=>{if(centralConsumed)throw Error('replay');centralConsumed=true;},approvedDelivery:async()=>({policy:{...delivery,account:'fixture',bucketId:'bckt_fixture',consumerName:'vm-fixture'},receiver:{baseUrl:'https://customer.example/',serviceToken:token}}),verifyReceiver:async()=>{}}});
 const reserve=net.createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
 const centralServer=await startCentralIssuerListener(central,port);let customerServer:import('node:http').Server|undefined;
 try{
 // Test-only injected transport maps the fixed HTTPS origin onto the actual local socket.
 const wire:typeof fetch=async(url,init)=>{expect(String(url)).toBe('https://central.example/internal');return fetch(`http://127.0.0.1:${port}/internal/customer-provider-enrollment`,init);};
 const ports=customerRelayEnrollmentPorts({approved:async()=>({delivery,contract,transport:{endpoint:'https://central.example/internal',serviceToken:token,contractHash:centralRelayContractHash(contract)}}),readback:async()=>m.readback()},wire);
 const config={serviceToken:token,ports,authority:{readRuntimeBinding:async()=>binding,authorize:async()=>{},consumeIntent:async()=>{if(consumed)throw Error('replay');consumed=true;}}};
 const request={customerId:delivery.customerId,instanceId:delivery.instanceId,approvalHash:delivery.approvalHash,providerKind:'zuplo',operation:'enrollment-issue',intentId:delivery.intentId};
 const spare=net.createServer();await new Promise<void>(r=>spare.listen(0,'127.0.0.1',r));const cp=(spare.address() as net.AddressInfo).port;await new Promise<void>(r=>spare.close(()=>r()));customerServer=await startCustomerEnrollmentListener(config,cp);const customerPort=(customerServer.address() as net.AddressInfo).port;
 const send=(body:unknown,auth=token)=>fetch(`http://127.0.0.1:${customerPort}/v1/enrollment`,{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(body)});
 expect((await send(request,'wrong')).status).toBe(401);expect(create).not.toHaveBeenCalled();
 const response=await send(request);expect(response.status).toBe(200);const result=await response.json();expect(result.providerResourceId).toBe('csmr_fixture');expect(JSON.stringify(result)).not.toContain('synthetic-only');expect(create).toHaveBeenCalledOnce();
 expect((await send(request)).status).not.toBe(200);expect(create).toHaveBeenCalledOnce();
 const {intentId,...read}=request;expect(await (await send({...read,operation:'enrollment-readback'})).json()).toEqual(result);
 }finally{if(customerServer)await new Promise<void>(r=>{customerServer!.close(()=>r());customerServer!.closeIdleConnections();});await centralServer.close();}
});
