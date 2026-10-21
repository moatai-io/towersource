import { queryOne } from '../../db/pg-repo.js';
import { randomUUID } from 'node:crypto';
/** Stable private session identity; source-protected contents use the secretary reader. */
export async function ensurePersonalSecretarySession(userId: number): Promise<string> {
  const row = await queryOne<{id:string}>(`INSERT INTO sessions(id,name,user_id,engine,visibility,label,auto_named)
    VALUES($1,'내 비서실',$2,'pi','private','personal_secretary',0)
    ON CONFLICT (user_id) WHERE label='personal_secretary' AND archived=0
    DO UPDATE SET name=sessions.name RETURNING id`, [randomUUID(),userId]);
  if (!row) throw new Error('secretary_session_unavailable');
  return row.id;
}

/** Read-time projection avoids duplicating source-protected text in generic storage. */
export async function readSecretarySessionMessages(sessionId: string) {
  const session = await queryOne<{user_id:number}>("SELECT user_id FROM sessions WHERE id=$1 AND label='personal_secretary'",[sessionId]);
  if (!session) return null;
  const { chatHistory } = await import('./chat.js');
  const history = await chatHistory(session.user_id);
  return [...history.messages.map(m=>({id:m.id,role:m.role,body:m.body,at:m.created_at})),
    ...history.proposals.map(p=>({id:p.id,role:'assistant',body:`${p.title}\n\n${p.body}`,at:p.createdAt}))]
    .sort((a,b)=>String(a.at).localeCompare(String(b.at)))
    .map(m=>({id:m.id,session_id:sessionId,role:m.role,content:JSON.stringify([{type:'text',text:m.body}]),created_at:m.at,parent_tool_use_id:null}));
}
