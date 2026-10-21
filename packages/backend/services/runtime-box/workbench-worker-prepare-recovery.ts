/** Owns compensation for partial Worker preparation, before a rollback handle exists.
 * Callers retain recovery-required classification on rejected preparation.
 * Callbacks must reissue a valid prior-scope identity, not reuse revoked tokens.
 * This handles caught failures, not process crashes or concurrent installers.
 */
export async function prepareWorkerWithRecovery(input: {
  prepare(): Promise<void>;
  restore(): Promise<void>;
  verifyRestored(): Promise<void>;
}): Promise<{ rollback(): Promise<void> }> {
  const rollback = async () => {
    await input.restore();
    await input.verifyRestored();
  };
  try {
    await input.prepare();
  } catch {
    try { await rollback(); }
    catch { throw new Error('WORKER_PREPARE_RECOVERY_REQUIRED'); }
    // Still reject: preparation did not succeed, even when compensation did.
    throw new Error('WORKER_PREPARE_FAILED_RESTORED');
  }
  return { rollback };
}
