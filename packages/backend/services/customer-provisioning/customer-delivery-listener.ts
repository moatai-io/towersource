import express from 'express';
import type {RequestHandler} from 'express';
import type {Server} from 'node:http';
import {createCustomerDeliveryRoute} from './customer-delivery-route.js';
export interface CustomerDeliveryListenerEnvironment {
 TOWER_CUSTOMER_DELIVERY_POLICY?:string;TOWER_CUSTOMER_DELIVERY_PORT?:string;
 TOWER_CUSTOMER_DELIVERY_TOKEN?:string;TOWER_INSTANCE_ID?:string;
}
/** Optional private customer receiver. No listener, migration, issuance or
 * settings changes unless an explicit installed policy was selected. */
export async function startCustomerDeliveryListener(env:CustomerDeliveryListenerEnvironment,postgresReady:boolean,routeFactory:typeof createCustomerDeliveryRoute=createCustomerDeliveryRoute):Promise<Server|undefined>{
 if(!env.TOWER_CUSTOMER_DELIVERY_POLICY)return undefined;
 const port=Number(env.TOWER_CUSTOMER_DELIVERY_PORT),token=env.TOWER_CUSTOMER_DELIVERY_TOKEN,instance=env.TOWER_INSTANCE_ID;
 if(!postgresReady||!Number.isInteger(port)||port<1024||port>65535||!token||token.length<32||/[\r\n]/.test(token)||!instance||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(instance))throw Error('customer_delivery_listener_configuration_invalid');
 let route:RequestHandler;
 try{route=routeFactory(env.TOWER_CUSTOMER_DELIVERY_POLICY,()=>token,()=>instance);}catch{throw Error('customer_delivery_listener_policy_unavailable');}
 const app=express();app.disable('x-powered-by');
 // Dedicated raw bounded adapter; not the main user API, proxy-trusted IP, or SPA.
 app.use(route);app.use((_req,res)=>res.status(404).json({error:'not_found'}));
 return new Promise((resolve,reject)=>{
  const server=app.listen(port,'127.0.0.1');server.requestTimeout=20000;server.headersTimeout=10000;server.maxHeadersCount=32;
  server.once('error',()=>reject(new Error('customer_delivery_listener_start_failed')));
  server.once('listening',()=>resolve(server));
 });
}
