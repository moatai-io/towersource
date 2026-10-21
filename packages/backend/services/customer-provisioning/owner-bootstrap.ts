import {ensureCpMappedUser} from '../auth/cp-login-users.js';
import type {CpLoginIdentity} from '../auth/cp-login-exchange.js';
import {createProject} from '../pm/project-manager.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
export interface ApprovedOwnerBootstrap {issuer:string;customerId:string;instanceId:string;approvalHash:string;creationCommandId:string;projectName:string;identity:CpLoginIdentity;}
export interface OwnerBootstrapAuthority {
 /** Authenticated current CP owner + approved installation binding. Never accept caller-provided role as authority. */
 load():Promise<ApprovedOwnerBootstrap>;
 assertInstalledIdentity(instanceId:string,approvalHash:string):Promise<void>;
 /** Fresh revocation/ownership read before each local write; transaction fences belong to implementation. */
 assertCurrent(approved:Readonly<ApprovedOwnerBootstrap>):Promise<void>;
}
/** Installation preparation only. Does not issue an SSO session, inference key or ready status. */
export async function bootstrapApprovedCustomerOwner(authority:OwnerBootstrapAuthority){
 const a=Object.freeze(structuredClone(await authority.load()));const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 const u=new URL(a.issuer);
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!uuid.test(a.instanceId)||a.identity.instanceId!==a.instanceId||a.identity.role!=='owner'||!uuid.test(a.identity.subjectId)||!uuid.test(a.identity.organizationId)||!uuid.test(a.creationCommandId)||! /^[a-f0-9]{64}$/.test(a.approvalHash)||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(a.customerId)||typeof a.projectName!=='string'||!a.projectName.trim()||a.projectName.length>120)throw Error('owner_bootstrap_binding_invalid');
 Object.freeze(a.identity);
 await authority.assertInstalledIdentity(a.instanceId,a.approvalHash);await authority.assertCurrent(a);
 const actor=await ensureCpMappedUser(u.origin,a.identity);if(actor.role!=='admin')throw Error('owner_bootstrap_role_invalid');
 await authority.assertCurrent(a);
 const project=await createProject(a.projectName,actor.userId,{creationCommandId:a.creationCommandId,description:'고객 초기 AI 연결을 위한 Workspace'});
 const binding={customerId:a.customerId,instanceId:a.instanceId,projectId:project.id,actorUserId:actor.userId};
 await authority.assertCurrent(a);await assertCustomerLocalVaultAccess(binding);
 return {...binding,approvalHash:a.approvalHash,ownerMapped:true as const,sessionIssued:false as const,aiConfigured:false as const};
}
