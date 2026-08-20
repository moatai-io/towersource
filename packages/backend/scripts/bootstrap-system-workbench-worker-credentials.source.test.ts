import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('./bootstrap-system-workbench-worker-credentials.ts', import.meta.url), 'utf8');

describe('system Workbench Worker credential bootstrap source contract', () => {
  it('registers the Worker before configuring the FK-backed transport credential', () => {
    expect(source.indexOf('await upsertWorkbenchWorker({')).toBeGreaterThan(-1);
    expect(source.indexOf('await configureWorkbenchWorkerTransportCredential')).toBeGreaterThan(source.indexOf('await upsertWorkbenchWorker({'));
  });

  it('rotates an active identity instead of deleting or silently duplicating it', () => {
    expect(source).toContain('rotateWorkbenchWorkerIdentity');
    expect(source).toContain('ACTIVE_WORKER_IDENTITY_COUNT');
    expect(source).not.toMatch(/DELETE FROM runtime_box_workbench_worker_identities/i);
  });

  it('stages generated secrets without printing their values', () => {
    expect(source).toContain('crypto.randomBytes(48)');
    expect(source).toContain('TOWER_REMOTE_WORKER_TOKEN=${transport}');
    expect(source).not.toMatch(/console\.log\([^\n]*(transport|issued\.token)/);
  });
});
