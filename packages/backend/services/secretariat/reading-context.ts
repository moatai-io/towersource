import { canAccessSession } from '../pm/project-access.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
import { secretariatStore } from './store.js';
import { safeCandidate } from './provider.js';
export async function readParticipatingContext(userId:number) {
  const sources=[];
  for(const candidate of (await secretariatStore.candidates(userId,true)).slice(0,10)) {
    if(!await isProjectMember(candidate.projectId,userId)||!(await canAccessSession(candidate.sessionId,userId,'member')).allowed)continue;
    const messages=(await secretariatStore.context(userId,candidate)).slice(-6).filter(m=>safeCandidate({title:'',outcome:m.text} as any));
    sources.push({projectId:candidate.projectId,sessionId:candidate.sessionId,title:candidate.title,updatedAt:candidate.updatedAt,messages});
  }
  return sources;
}
