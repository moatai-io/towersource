import type { WorkbenchExecutionProvider } from '../execution/execution-broker.js';

/** Selection may reserve capacity before Vault resolution. Release it if preparation fails.
 * Successful preparation transfers ownership to execution; never release a running Job early.
 */
export async function prepareWorkbenchCredentials<T>(provider: WorkbenchExecutionProvider, prepare: () => Promise<T>): Promise<T> {
  try {
    return await prepare();
  } catch (error) {
    // Preserve the original selection failure even if reservation cleanup also fails.
    try { await provider.releaseReservation?.(); } catch { /* Lease expiry remains the fallback. */ }
    throw error;
  }
}
