import { describe, expect, it } from 'vitest';
import { refreshPiRecoveryContext } from './compaction-recovery.js';

describe('canonical recovery context', () => {
  it('appends content edits before refreshing without mutating source or tool identity', () => {
    const original = { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] };
    const edits: any[] = [];
    const manager = {
      buildSessionProjection: () => ({ entries: [{ sourceEntry: { type: 'message', id: 'entry-1' }, messages: [original] }] }),
      appendContextEdit: (id: string, replacement: any) => edits.push({ id, replacement }),
    };
    let refreshed = false;
    refreshPiRecoveryContext(manager, {}, () => { expect(edits).toHaveLength(1); refreshed = true; });
    expect(refreshed).toBe(true);
    expect(edits[0].id).toBe('entry-1');
    expect(edits[0].replacement.content[0].type).toBe('text');
    expect(original.content[0].type).toBe('image');
    expect(original.toolCallId).toBe('call-1');
  });
  it('fails before edits when canonical refresh is unavailable', () => {
    const manager = { buildSessionProjection: () => { throw new Error('must not inspect'); }, appendContextEdit() {} };
    expect(() => refreshPiRecoveryContext(manager, {})).toThrow('requires AgentSession.refreshContext');
  });
});

it('does not replace historical tool arguments with recovery previews', () => {
 const message={role:'assistant',content:[{type:'toolCall',id:'executed',name:'write',arguments:{path:'example.txt',content:'x'.repeat(10000)}}]};
 let edits=0;
 refreshPiRecoveryContext({buildSessionProjection:()=>({entries:[{sourceEntry:{type:'message',id:'m'},messages:[message]}]}),appendContextEdit:()=>edits++}, {}, ()=>{});
 expect(edits).toBe(0);
});
