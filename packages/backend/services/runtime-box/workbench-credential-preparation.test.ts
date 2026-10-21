import { expect, it, vi } from 'vitest';
import type { WorkbenchExecutionProvider } from '../execution/execution-broker.js';
import { prepareWorkbenchCredentials } from './workbench-credential-preparation.js';
function provider(release = vi.fn().mockResolvedValue(undefined)) {
  return { kind: 'remote-worker', releaseReservation: release } as unknown as WorkbenchExecutionProvider;
}
it('releases capacity when Credential preparation fails, preserving original error', async () => {
  const p = provider(); const error = new Error('PROJECT_CONNECTION_DENIED');
  await expect(prepareWorkbenchCredentials(p, async () => { throw error; })).rejects.toBe(error);
  expect(p.releaseReservation).toHaveBeenCalledOnce();
});
it('does not release capacity before successful execution takes ownership', async () => {
  const p = provider();
  await expect(prepareWorkbenchCredentials(p, async () => ({ selected: true }))).resolves.toEqual({ selected: true });
  expect(p.releaseReservation).not.toHaveBeenCalled();
});
it('does not replace Credential error with cleanup error', async () => {
  const p = provider(vi.fn().mockRejectedValue(new Error('cleanup failed')));
  const error = new Error('selection failed');
  await expect(prepareWorkbenchCredentials(p, async () => { throw error; })).rejects.toBe(error);
});
it('supports providers without a reservation', async () => {
  const error = new Error('selection failed');
  await expect(prepareWorkbenchCredentials({ kind: 'local-runtime' } as WorkbenchExecutionProvider, async () => { throw error; })).rejects.toBe(error);
});
