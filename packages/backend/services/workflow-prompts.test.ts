import { describe, expect, it } from 'vitest';
import { buildWorkflowPrompt } from './workflow-prompts.js';

describe('workflow prompts shared-root policy', () => {
  it.each(['feature', 'big_task'] as const)('keeps %s work in the canonical project directory', (workflow) => {
    const prompt = buildWorkflowPrompt('Focused change', 'Implement and verify it.', workflow);

    expect(prompt).toContain('## Shared Root Safety');
    expect(prompt).toContain('Work in the canonical project directory.');
    expect(prompt).toContain('Do not create or switch to a git worktree or separate branch.');
    expect(prompt).not.toContain('## Worktree Note');
    expect(prompt).not.toContain('requiring a dedicated branch');
  });

  it('classifies feature work without prescribing a branch', () => {
    const prompt = buildWorkflowPrompt('Classify change', 'Choose the workflow.', 'auto');

    expect(prompt).toContain('New functionality or refactors that need focused implementation and verification');
    expect(prompt).not.toContain('New feature requiring a dedicated branch');
  });
});
