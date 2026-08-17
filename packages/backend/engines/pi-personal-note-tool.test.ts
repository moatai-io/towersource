import { describe, expect, it } from 'vitest';
import { createPersonalNoteAppendTool } from './pi-personal-note-tool.js';

describe('personal_note_append tool contract', () => {
  it('is closure-scoped and exposes the intended trigger language', () => {
    const tool = createPersonalNoteAppendTool({ userId: 7, sessionId: 'session-1' });
    expect(tool.name).toBe('personal_note_append');
    expect(tool.description).toContain('노트에 기록');
    expect(tool.promptGuidelines?.join(' ')).toContain('checklist=true');
    expect(tool.promptGuidelines?.join(' ')).toContain('Do not call present_file');
    expect(tool.promptGuidelines?.join(' ')).toContain('내 할 일 · My Todo');
    expect(tool.promptGuidelines?.join(' ')).toContain('진행 단계 · Work Steps');
  });

  it('instructs the model to use checklist mode for private todos and not chain present_file', () => {
    const tool = createPersonalNoteAppendTool({ userId: 7, sessionId: 'session-1' });
    const guidelines = tool.promptGuidelines?.join(' ') || '';
    expect(guidelines).toContain('checklist=true');
    expect(guidelines).toContain('내 할 일 · My Todo');
    expect(guidelines).toContain('진행 단계 · Work Steps');
    expect(guidelines).toContain('Do not call present_file');
    expect(tool.description).toContain('Viewer Pane');
  });

  it('refuses execution without an authenticated user', async () => {
    const tool = createPersonalNoteAppendTool({ sessionId: 'session-1' });
    const result = await tool.execute('call-1', { text: '테스트 기록', checklist: false } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('authenticated user context is missing');
  });
});
