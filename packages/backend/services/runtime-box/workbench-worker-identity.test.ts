import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: { jwtSecret: 'test-worker-identity-secret' } }));

import { issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity, WORKBENCH_WORKER_AUDIENCE } from './workbench-worker-identity.js';

describe('Remote Workbench Worker identity', () => {
  beforeEach(() => vi.useRealTimers());

  it('binds Worker ID, exact Project scope, capabilities, audience, and expiration', () => {
    const issued = issueWorkbenchWorkerIdentity({ workerId: 'worker-a', projectIds: ['p2', 'p1', 'p1'], capabilities: ['shell', 'job', 'job'], expiresIn: '1h' });
    expect(issued.identity).toMatchObject({ workerId: 'worker-a', projectIds: ['p1', 'p2'], capabilities: ['job', 'shell'] });
    expect(verifyWorkbenchWorkerIdentity(issued.token)).toEqual(issued.identity);
    const decoded = jwt.decode(issued.token) as any;
    expect(decoded).toMatchObject({ aud: WORKBENCH_WORKER_AUDIENCE, sub: 'workbench-worker:worker-a' });
  });

  it('rejects tampered, expired, wrong-audience, and empty-scope identities', () => {
    const issued = issueWorkbenchWorkerIdentity({ workerId: 'worker-a', projectIds: ['p1'], capabilities: ['job'], expiresIn: '1h' });
    expect(verifyWorkbenchWorkerIdentity(`${issued.token}x`)).toBeNull();
    expect(verifyWorkbenchWorkerIdentity(jwt.sign({ worker_id: 'worker-a', project_ids: ['p1'], capabilities: ['job'] }, 'test-worker-identity-secret', { audience: 'other', subject: 'workbench-worker:worker-a', jwtid: 'j', expiresIn: '1h' }))).toBeNull();
    expect(() => issueWorkbenchWorkerIdentity({ workerId: 'worker-a', projectIds: [], capabilities: ['job'] })).toThrow('WORKER_SCOPE_EMPTY');
  });
});
