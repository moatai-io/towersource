/** resultId is polymorphic; completed-session runner refs explicitly identify verified AI results. */
export function automationResultSessionId(
  result: { resultId: string | null; runnerKind: string | null; runnerRef?: string | null },
  automation: { mode: string; jobType?: string },
): string | null {
  if (result.runnerKind !== 'ai' || result.runnerRef?.startsWith('workbench-')) return null;
  if (result.runnerRef?.startsWith('completed-session:')) return result.runnerRef.slice('completed-session:'.length);
  if (automation.mode !== 'inject' && automation.mode !== 'channel') return null;
  return result.resultId;
}

/** Historical spawn successes attest to dispatch only, never to task or delivery completion. */
export function isUnverifiedAiSpawn(
  run: { mode: string; runnerKind: string | null; status: string; runnerRef?: string | null },
  automation: { jobType: string },
): boolean {
  return !run.runnerRef?.startsWith('completed-') && automation.jobType === 'ai_prompt' && run.mode === 'spawn'
    && (run.runnerKind === 'ai' || run.runnerKind === null)
    && (run.status === 'success' || run.status === 'spawned');
}
