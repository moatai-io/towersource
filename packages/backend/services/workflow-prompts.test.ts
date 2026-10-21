import { describe, expect, it } from 'vitest';
import { buildUnattendedPrompt } from './workflow-prompts.js';

describe('unattended execution contract', () => {
  it('uses a domain-neutral contract without a workflow selector', () => {
    const prompt = buildUnattendedPrompt('고객 보고서', '필수 항목을 검증해 보고서를 작성');
    expect(prompt).toBe(buildUnattendedPrompt('고객 보고서', '필수 항목을 검증해 보고서를 작성'));
    expect(prompt).toContain('Keep your existing project identity');
    expect(prompt).toContain('essential input or approval is missing');
    expect(prompt).toContain('Work in the canonical project directory.');
    expect(prompt).toContain('Preserve unrelated changes.');
    for (const obsolete of ['kanban', '## Active Skills', '## Skill:', 'Commit Gate', '[WORKFLOW:', 'curl ', '/api/tasks', 'Research →']) {
      expect(prompt).not.toContain(obsolete);
    }
  });
  it('preserves explicit outcome markers without making progress stages mandatory', () => {
    const prompt = buildUnattendedPrompt('Check', 'Inspect only');
    expect(prompt).toContain('[TASK COMPLETE]');
    expect(prompt).toContain('[TASK NONE]');
    expect(prompt).toContain('[TASK FAILED: short reason]');
    expect(prompt).toContain('exactly one terminal marker');
    expect(prompt).toContain('it is optional');
    expect(prompt).toContain('Never use this for errors');
    expect(prompt).toContain('outcome has been verified');
  });
  it('resumes from evidence without authorizing duplicate effects or interpolating API actions', () => {
    const prompt = buildUnattendedPrompt('Resume', 'Finish authorized work', {
      isResume: true, previousProgress: ['Report was saved'],
    });
    expect(prompt).toContain('Report was saved');
    expect(prompt).toContain('not proof that an action completed');
    expect(prompt).toContain('Do not repeat completed external actions');
    expect(prompt).not.toContain('private-task');
    expect(prompt).not.toContain('internal.invalid');
  });
  it('does not invent history when resuming without progress notes', () => {
    expect(buildUnattendedPrompt('Resume', 'Check state', { isResume: true })).toContain('do not invent them');
  });
});
