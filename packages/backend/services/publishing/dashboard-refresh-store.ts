import { transaction } from '../../db/pg-repo.js';
import type { DashboardRefreshBinding } from './dashboard-refresh.js';
export type StoredRefreshBinding = DashboardRefreshBinding & {version:number};
export type RefreshClaim = {kind:'claimed';binding:StoredRefreshBinding} | {kind:'existing';state:string;runId:string|null;status:string|null};
/** Internal persistence only: caller must authenticate, authorize publication and execution before claiming. */
export async function claimDashboardRefresh(publicationId:string, userId:number, requestId:string, expectedVersion:number):Promise<RefreshClaim> {
  if(!publicationId || !Number.isSafeInteger(userId)||userId<=0||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)||!Number.isInteger(expectedVersion)||expectedVersion<1)throw Error('invalid_refresh_request');
  return transaction(async client=>{
    const {rows}=await client.query('SELECT * FROM dashboard_refresh_bindings WHERE publication_id=$1 FOR UPDATE',[publicationId]);
    const row=rows[0];
    if(!row||!row.enabled||row.version!==expectedVersion)throw Error('binding_unavailable');
    const claim=await client.query(`INSERT INTO dashboard_refresh_requests(publication_id,actor_user_id,request_id,binding_version,state) VALUES($1,$2,$3,$4,'claimed') ON CONFLICT DO NOTHING RETURNING request_id`,[publicationId,userId,requestId,expectedVersion]);
    if(claim.rows.length)return {kind:'claimed',binding:{publicationId,ownerProjectId:row.owner_project_id,automationId:row.automation_id,version:row.version}};
    const prior=await client.query('SELECT state,run_id,result_status,binding_version FROM dashboard_refresh_requests WHERE publication_id=$1 AND actor_user_id=$2 AND request_id=$3',[publicationId,userId,requestId]);
    const receipt=prior.rows[0];if(!receipt||receipt.binding_version!==expectedVersion)throw Error('request_version_conflict');
    return {kind:'existing',state:receipt.state,runId:receipt.run_id,status:receipt.result_status};
  });
}
