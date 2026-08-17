/**
 * Workflow Prompts — skill prompt constants + builder function.
 * Pure functions, no external dependencies.
 */

import type { WorkflowMode } from './task/task-manager.js';

// ─── Skill Prompt Constants ─────────────────────────────────────────────────

const COMMIT_GATE = `
## Skill: Commit Gate
Before every git commit:
1. Run \`git diff --cached\` to review staged changes
2. Check for secrets, API keys, passwords, .env content — NEVER commit these
3. Run type-check if TypeScript: \`npx tsc --noEmit --skipLibCheck 2>&1 | head -20\`
4. Each commit must be a single logical unit — one purpose per commit
5. Write a clear commit message: imperative mood, explain WHY not WHAT
6. If you find issues, fix them before committing — don't commit broken code
`;

const SELF_REVIEW = `
## Skill: Self-Review
After completing implementation, switch perspective and review your own changes:
1. **Security**: Check for injection, XSS, path traversal, exposed secrets
2. **Edge cases**: Empty inputs, null values, concurrent access, large data
3. **Style**: Follow existing codebase conventions (naming, formatting, patterns)
4. **Performance**: Avoid N+1 queries, unnecessary re-renders, memory leaks
5. If you find issues, fix them immediately — don't just note them
6. Run a final \`git diff\` to verify all changes look correct
`;

const BRANCH_FINISH = `
## Skill: Change Finish
Before declaring the task complete:
1. Remove all debug code: console.log for debugging, TODO comments you added, test data
2. Review the files changed by this task and keep unrelated working-tree changes untouched
3. Write a change summary with:
   - What was changed and why
   - Files modified (list the key ones)
   - Any decisions made during implementation
4. If committing is part of the task, stage only the specific files owned by this task
`;

const TASK_DECOMPOSE = (apiBaseUrl: string, taskId: string) => `
## Skill: Task Decompose
If this task is too large to complete in one session (estimated 30+ minutes of work),
break it into smaller sub-tasks by calling the Tower API:

\`\`\`bash
curl -s -X POST ${apiBaseUrl}/api/tasks \\
  -H 'Content-Type: application/json' \\
  -d '{
    "title": "Sub-task title",
    "description": "Detailed description of this piece",
    "cwd": "<same working directory>",
    "workflow": "default",
    "parentTaskId": "${taskId}"
  }'
\`\`\`

Guidelines:
- Only decompose if the task genuinely has 3+ distinct phases
- Each sub-task should be independently completable
- Set appropriate workflow: "simple" for reports, "default" for light code, "feature" for new features
- After creating sub-tasks, continue working on the first one yourself
- The parent task (this one) should coordinate, not do all the work
`;

const PROGRESS_REPORT = `
## Skill: Progress Report
At each stage transition, output a structured progress update:
\`\`\`
[STAGE: StageName]
- What was completed in the previous stage
- What will be done in this stage
- Any blockers or decisions made
\`\`\`
Keep it concise (3-5 lines max per report).
`;

const TRIAGE = `
## Skill: Triage (Auto-mode)
You are in auto workflow mode. Before starting work, analyze the task and classify it:

1. Read the task title and description carefully
2. Determine the appropriate workflow:
   - **simple**: No code changes needed (reports, analysis, documentation)
   - **default**: Light code modifications (bug fixes, small changes, config updates)
   - **feature**: New functionality or refactors that need focused implementation and verification
   - **big_task**: Large task that should be decomposed into sub-tasks

3. Output your classification on a single line:
   \`[WORKFLOW: simple|default|feature|big_task]\`

4. Then proceed with the task using that workflow's approach.

Important: Output the [WORKFLOW: X] marker EARLY — within your first response.
`;

// ─── Prompt Builder ─────────────────────────────────────────────────────────

export function buildWorkflowPrompt(
  title: string,
  description: string,
  workflow: WorkflowMode,
  options?: {
    taskId?: string;
    parentTaskId?: string;
    apiBaseUrl?: string;
    isResume?: boolean;
    previousProgress?: string[];
  },
): string {
  const { taskId, apiBaseUrl = 'http://localhost:32355', isResume, previousProgress } = options || {};

  // Base task section
  const resumeTag = isResume ? ' (Resuming)' : '';
  const progressSection = isResume && previousProgress && previousProgress.length > 1
    ? `\n\n## Progress Before Interruption\nCompleted stages: ${previousProgress.slice(1).join(' → ')}`
    : '';

  let prompt = `# Task: ${title}${resumeTag}

${description}${progressSection}

## Instructions
You are an autonomous agent executing a kanban task.`;

  if (isResume) {
    prompt += `\nThis task was interrupted and you are resuming. Review conversation history above, then continue from where work stopped.`;
  }

  prompt += `\n\nWork through these stages:
1. **Research** — Understand the problem, read relevant files, gather context
2. **Plan** — Outline your approach briefly
3. **Implement** — Make the necessary changes
4. **Verify** — Run tests or verify your changes work correctly

At the start of each stage, output: \`[STAGE: StageName]\`
When complete: \`[TASK COMPLETE]\`
On unrecoverable error: \`[TASK FAILED: reason]\`

Work autonomously. Do not ask questions — make reasonable decisions and proceed.`;

  // Inject skills based on workflow mode
  const skills: string[] = [];

  switch (workflow) {
    case 'auto':
      skills.push(TRIAGE);
      skills.push(PROGRESS_REPORT);
      break;

    case 'simple':
      // No skills — minimal overhead for simple tasks
      break;

    case 'default':
      skills.push(COMMIT_GATE);
      skills.push(PROGRESS_REPORT);
      break;

    case 'feature':
      skills.push(COMMIT_GATE);
      skills.push(SELF_REVIEW);
      skills.push(BRANCH_FINISH);
      skills.push(PROGRESS_REPORT);
      break;

    case 'big_task':
      skills.push(COMMIT_GATE);
      skills.push(SELF_REVIEW);
      skills.push(BRANCH_FINISH);
      skills.push(PROGRESS_REPORT);
      if (taskId) {
        skills.push(TASK_DECOMPOSE(apiBaseUrl, taskId));
      }
      break;
  }

  if (skills.length > 0) {
    prompt += '\n\n---\n\n# Active Skills\nFollow these skills during your work:\n';
    prompt += skills.join('\n');
  }

  if (workflow === 'feature' || workflow === 'big_task') {
    prompt += `\n\n## Shared Root Safety
Work in the canonical project directory. Do not create or switch to a git worktree or separate branch.
Inspect existing changes before editing, modify only files owned by this task, and leave unrelated changes untouched.`;
  }

  return prompt;
}
