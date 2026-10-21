import fs from 'node:fs';import path from 'node:path';
import {queryOne} from '../../db/pg-repo.js';
import {startInstalledCustomerServiceGroup} from './installed-customer-service-group.js';
type GroupConfig=Parameters<typeof startInstalledCustomerServiceGroup>[0];
/** Explicit opt-in. Root installation is a separate approved action; never discovers or creates credentials. */
export async function startCustomerServiceStartup(env:NodeJS.ProcessEnv,postgresReady:boolean,start:typeof startInstalledCustomerServiceGroup=startInstalledCustomerServiceGroup){
 const file=env.TOWER_CUSTOMER_SERVICE_CONFIG;if(!file)return undefined;
 if(!postgresReady||env.TOWER_CUSTOMER_DELIVERY_POLICY)throw Error('customer_service_startup_conflict_or_database_missing');
 const load=()=>{
  if(!path.isAbsolute(file)||file.split('/').includes('..'))throw Error('customer_service_config_path_invalid');
  for(let p=path.dirname(file);;p=path.dirname(p)){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw Error('customer_service_config_unprotected');if(p===path.dirname(p))break;}
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||s.size>32768)throw Error('customer_service_config_unprotected');const b=Buffer.alloc(32769);const n=fs.readSync(fd,b,0,b.length,0);if(n>32768)throw Error('customer_service_config_oversized');return b.subarray(0,n);}finally{fs.closeSync(fd);}
 };
 const bytes=load();const configs=parseCustomerServiceConfigs(JSON.parse(bytes.toString()),env);
 const assertCurrent=()=>{if(!bytes.equals(load())||configs.some(c=>Date.parse(c.expiresAt)<=Date.now()||env.TOWER_INSTANCE_ID!==c.instanceId))throw Error('customer_service_config_changed');};
 const preflight=async()=>{assertCurrent();const r=await queryOne<{ready:boolean}>("SELECT to_regclass('public.customer_owner_bootstrap_approvals') IS NOT NULL AND to_regclass('public.customer_runtime_approvals') IS NOT NULL AND to_regclass('public.customer_service_intents') IS NOT NULL AND to_regclass('public.customer_delivery_intents') IS NOT NULL AND to_regclass('public.gateway_profiles') IS NOT NULL AS ready",[]);if(!r?.ready)throw Error('customer_service_schema_missing');};
 await preflight();const groups:Array<{close():Promise<void>}>=[];
 let closed=false;const close=async()=>{if(closed)return;closed=true;let failed=false;for(const g of groups.reverse())try{await g.close();}catch{failed=true;}if(failed)throw Error('customer_services_cleanup_incomplete');};
 try{for(const c of configs)groups.push(await start({...c.group,preflight,localInstanceId:()=>{assertCurrent();return c.instanceId;},installed:async()=>{assertCurrent();return {instanceId:c.instanceId,approvalHash:c.group.approvalHash};}}));return {close};}
 catch(error){try{await close();}catch{throw Error('customer_services_start_and_cleanup_failed');}throw error;}

}
export function parseCustomerServiceConfig(raw:any,env:NodeJS.ProcessEnv):{expiresAt:string;instanceId:string;group:Omit<GroupConfig,'preflight'|'installed'|'localInstanceId'>}{
 const exact=(x:any,keys:string[])=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))throw Error('customer_service_config_shape');};
 exact(raw,['schemaVersion','expiresAt','instanceId','approvalHash','port','deliveryPort','observationPort','serviceTokenEnv','observationTokenEnv','deliveryPolicyFile','relay','target']);
 if(raw.schemaVersion!==1||!Number.isFinite(Date.parse(raw.expiresAt))||Date.parse(raw.expiresAt)<=Date.now()||!/^[a-f0-9-]{36}$/.test(raw.instanceId)||raw.instanceId!==env.TOWER_INSTANCE_ID||!/^[a-f0-9]{64}$/.test(raw.approvalHash))throw Error('customer_service_identity_invalid');
 const ports=[raw.port,raw.deliveryPort,raw.observationPort];if(new Set(ports).size!==3||ports.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw Error('customer_service_ports_invalid');
 exact(raw.relay,['approvalDirectory','intentDirectory','endpoint','tokenEnv']);exact(raw.target,['customerId','instanceId','proposalHash','providerKind']);
 for(const p of [raw.deliveryPolicyFile,raw.relay.approvalDirectory,raw.relay.intentDirectory])if(typeof p!=='string'||!path.isAbsolute(p)||p.split('/').includes('..'))throw Error('customer_service_path_invalid');
 const u=new URL(raw.relay.endpoint);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('customer_service_endpoint_invalid');
 if(raw.target.instanceId!==raw.instanceId||!['zuplo','litellm'].includes(raw.target.providerKind)||!/^[a-f0-9]{64}$/.test(raw.target.proposalHash)||typeof raw.target.customerId!=='string'||!raw.target.customerId)throw Error('customer_service_target_invalid');
 const token=(name:string)=>{if(typeof name!=='string'||!/^TOWER_[A-Z0-9_]+_TOKEN$/.test(name)||!env[name]||env[name]!.length<32||/[\r\n]/.test(env[name]!))throw Error('customer_service_token_unavailable');return env[name]!;};
 return {expiresAt:raw.expiresAt,instanceId:raw.instanceId,group:{port:raw.port,deliveryPort:raw.deliveryPort,observationPort:raw.observationPort,approvalHash:raw.approvalHash,deliveryPolicyFile:raw.deliveryPolicyFile,serviceToken:token(raw.serviceTokenEnv),observationToken:token(raw.observationTokenEnv),relay:{approvalDirectory:raw.relay.approvalDirectory,intentDirectory:raw.relay.intentDirectory,endpoint:raw.relay.endpoint,serviceToken:token(raw.relay.tokenEnv)},target:structuredClone(raw.target)}};
}

/** Version 2 selects both provider groups under one approval; no silent partial bundle. */
export function parseCustomerServiceConfigs(raw:any,env:NodeJS.ProcessEnv):Array<ReturnType<typeof parseCustomerServiceConfig>>{
 if(raw?.schemaVersion!==2)return [parseCustomerServiceConfig(raw,env)];
 if(Object.keys(raw).sort().join(',')!=='groups,schemaVersion'||!Array.isArray(raw.groups)||raw.groups.length!==2)throw Error('customer_services_bundle_invalid');
 const groups=raw.groups.map((g:any)=>parseCustomerServiceConfig(g,env));
 if(new Set(groups.map((g:any)=>g.group.target.providerKind)).size!==2||groups.some((g:any)=>g.instanceId!==groups[0].instanceId||g.group.approvalHash!==groups[0].group.approvalHash||g.group.target.customerId!==groups[0].group.target.customerId))throw Error('customer_services_bundle_identity_mismatch');
 const ports=groups.flatMap((g:any)=>[g.group.port,g.group.deliveryPort,g.group.observationPort]);if(new Set(ports).size!==6)throw Error('customer_services_bundle_ports_conflict');
 return groups;
}
