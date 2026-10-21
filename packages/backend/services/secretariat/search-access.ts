import { queryOne } from '../../db/pg-repo.js';
import { canAccessSession } from '../pm/project-access.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
import { participatedSessionSql } from './session-scope.js';
export async function secretaryReadableSession(userId:number,sessionId:string) {
 const row=await queryOne<{project_id:string}>(`SELECT s.project_id FROM sessions s
 WHERE s.id=$1 AND ${participatedSessionSql('$2')} AND s.archived=0
 AND s.parent_session_id IS NULL AND COALESCE(s.label,'') NOT IN ('personal_secretary','worker','support')
 AND NOT EXISTS(SELECT 1 FROM agent_workers w WHERE w.backing_session_id=s.id)`,[sessionId,userId]);
 if(!row?.project_id||!await isProjectMember(row.project_id,userId)||!(await canAccessSession(sessionId,userId,'member')).allowed)return null;
 return {projectId:row.project_id,sessionId};
}
