/** Unattended execution contract; independent of legacy Kanban workflow modes. */

export function buildUnattendedPrompt(
  title: string,
  description: string,
  options?: {
    isResume?: boolean;
    previousProgress?: string[];
  },
): string {
  const { isResume, previousProgress } = options || {};
  const resumeContext = isResume ? `

## Resume context
This execution was interrupted. Check available history, saved results, and the current state before continuing. Prior progress notes are observations, not proof that an action completed. Do not repeat completed external actions or assume an uncertain action is safe to retry. If its outcome cannot be established, report the blocker.
${previousProgress?.length ? `\nPrevious progress notes:\n${previousProgress.map(note => `- ${note}`).join('\n')}` : 'No prior progress notes are available; do not invent them.'}` : '';

  return `# Task: ${title}${isResume ? ' (Resuming)' : ''}

${description}${resumeContext}

## Unattended execution
Keep your existing project identity, instructions, tools, and service-specific skills. This request changes the execution mode, not your role or authority.
Perform the requested work within its authorized scope. Choose the steps appropriate to the task; no mandatory research, planning, coding, or classification sequence is required.
Make reasonable reversible decisions. When essential input or approval is missing, report the concrete blocker rather than guessing or bypassing approval; finish independent authorized work when possible.
Use available inputs and verify the requested outcome against the user's requirements. Do not claim checks you did not perform. Distinguish verified results, uncertainty, and incomplete work in the final report.
Do not create additional tasks, delegate, commit, deploy, or perform external writes merely because this is an automation. Follow the existing request, project rules, and approval requirements.
Work in the canonical project directory. Preserve unrelated changes. This execution does not authorize switching workspaces, branches, or worktrees.

## Progress and terminal reporting
Report a meaningful update only for a material finding, blocker, or long-running delay. You may use \`[STAGE: short description]\` for useful progress; it is optional and does not prescribe a workflow.
End with a concise report of the outcome, evidence, and any remaining limitations, followed by exactly one terminal marker:
- \`[TASK COMPLETE]\` — the requested work is complete and its outcome has been verified.
- \`[TASK NONE]\` — the requested check completed successfully and there is genuinely nothing to process. Never use this for errors, missing access, unavailable inputs, or incomplete checks.
- \`[TASK FAILED: short reason]\` — the request could not be completed, including a required approval or input blocker. State what was completed and what remains blocked in the report.
These markers report execution status; they do not replace outcome verification. Mention marker examples only in these instructions, not as additional markers in your response.`;
}
