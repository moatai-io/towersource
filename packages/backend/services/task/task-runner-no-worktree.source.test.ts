import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const TASK_RUNNER_PATH = path.resolve(import.meta.dirname, './task-runner.ts');

describe('task runner shared-root source contract', () => {
  it('does not create worktrees for explicit or auto-classified workflows', () => {
    const source = fs.readFileSync(TASK_RUNNER_PATH, 'utf8');

    expect(source).not.toContain("import { createWorktree }");
    expect(source).not.toContain('createWorktree(cwd, taskId, title)');
    expect(source).not.toContain('Created isolated workspace:');
    expect(source).not.toContain('Late worktree created:');
    expect(source).toContain('classification must never create another worktree');
  });

  it('retains resume compatibility for historical task worktrees only', () => {
    const source = fs.readFileSync(TASK_RUNNER_PATH, 'utf8');

    expect(source).toContain('if (resumeEngineSessionId)');
    expect(source).toContain('existingTask?.worktreePath && fs.existsSync(existingTask.worktreePath)');
    expect(source).toContain('agentCwd = existingTask.worktreePath');
  });
});
