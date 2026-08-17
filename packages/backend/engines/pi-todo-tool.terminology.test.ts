import { describe, expect, it } from 'vitest';
import { todoWriteTool } from './pi-todo-tool.js';

describe('TodoWrite terminology contract', () => {
  it('distinguishes AI Work Steps from the user My Todo checklist', () => {
    expect(todoWriteTool.label).toBe('진행 단계');
    expect(todoWriteTool.description).toContain('진행 단계 · Work Steps');
    expect(todoWriteTool.description).toContain('내 할 일 · My Todo');
    expect(todoWriteTool.promptGuidelines?.join(' ')).toContain('personal_note_append');
  });
});
