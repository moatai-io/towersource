import { describe, expect, it } from 'vitest';
import { todoWriteTool } from './pi-todo-tool.js';
import { COMPLETED_WORK_RECOMMENDATION_GUIDELINE, DELEGATED_WORK_COMPLETION_GUIDELINES, LONG_RUNNING_WORK_ROADMAP_GUIDELINE } from '../services/delegated-work-policy.js';

describe('TodoWrite terminology contract', () => {
  it('requires a roadmap before work expected to take at least 20 minutes in shared and tool prompts', () => {
    expect(DELEGATED_WORK_COMPLETION_GUIDELINES).toContain(LONG_RUNNING_WORK_ROADMAP_GUIDELINE);
    expect(todoWriteTool.promptGuidelines).toContain(LONG_RUNNING_WORK_ROADMAP_GUIDELINE);
    expect(todoWriteTool.description).toContain('20 minutes or more');
    expect(todoWriteTool.promptSnippet).toContain('before starting work expected to take 20 minutes or more');
    expect(LONG_RUNNING_WORK_ROADMAP_GUIDELINE).toContain('Do not wait until 20 minutes have elapsed');
    expect(LONG_RUNNING_WORK_ROADMAP_GUIDELINE).toContain('investigation or analysis');
    expect(LONG_RUNNING_WORK_ROADMAP_GUIDELINE).toContain('create or update the roadmap immediately');
  });

  it('distinguishes AI Work Steps from the user My Todo checklist', () => {
    expect(todoWriteTool.label).toBe('진행 단계');
    expect(todoWriteTool.description).toContain('진행 단계 · Work Steps');
    expect(todoWriteTool.description).toContain('내 할 일 · My Todo');
    expect(todoWriteTool.promptGuidelines?.join(' ')).toContain('personal_note_append');
  });

  it('reuses the shared proactive new-work recommendation policy after completion', () => {
    const guidelines = todoWriteTool.promptGuidelines?.join(' ') ?? '';
    expect(guidelines).toContain(COMPLETED_WORK_RECOMMENDATION_GUIDELINE);
    expect(guidelines).toContain('immediately before it');
    expect(guidelines).toContain('1–3 highest-value actions');
    expect(guidelines).toContain('even when one next action is clearly best');
    expect(guidelines).toContain('check its coverage against the original request');
    expect(guidelines).not.toContain('make recommendation 1 a directly selectable “계속 진행” action');
  });

  it('does not disguise remaining executable work as a completed checklist or future recommendation', () => {
    const guidelines = todoWriteTool.promptGuidelines?.join(' ') ?? '';
    expect(guidelines).toContain('continue it rather than closing the run');
    expect(guidelines).toContain('leave unfinished items pending/in_progress');
    expect(guidelines).toContain('concrete blocker and resumption condition');
    expect(guidelines).toContain('do not mark unfinished work completed or move it to backlog or recommendations');
  });
});
