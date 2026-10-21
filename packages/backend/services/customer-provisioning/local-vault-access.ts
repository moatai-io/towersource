import {assertCredentialManagementAccess} from '../credential-vault/credential-management-access.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
/** Reuses Tower's canonical fresh user/membership ACL. Does not mint an actor or grant membership. */
export async function assertCustomerLocalVaultAccess(binding:CustomerRuntimeBinding):Promise<void>{
 await assertCredentialManagementAccess({actorUserId:binding.actorUserId,scope:'project',projectId:binding.projectId,action:'write'});
 await assertCredentialManagementAccess({actorUserId:binding.actorUserId,scope:'workspace',action:'admin'});
}
