import type { RehydrateInputMessage } from '../../engines/types.js';
/** Keep stable message identity across rebuilds; no arbitrary context-window truncation. */
export function buildResumeMessages(history: Array<{id:string;role:string;body:string}>): RehydrateInputMessage[] {
  const seen=new Set<string>();
  return history.flatMap(message=>{
    if(seen.has(message.id)||!message.body.trim()||!['user','assistant'].includes(message.role))return [];
    seen.add(message.id);
    return [{id:message.id,role:message.role as 'user'|'assistant',content:[{type:'text',text:message.body}]}];
  });
}
