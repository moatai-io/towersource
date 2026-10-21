import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/execution/worker/worker-repository.js', () => ({
  upsertWorkbenchWorker: vi.fn(), heartbeatPersistedWorkbenchWorker: vi.fn(),
  listPersistedWorkbenchWorkers: vi.fn(), setPersistedWorkbenchWorkerDrain: vi.fn(),
}));
const identities = vi.hoisted(() => ({
  assertWorkbenchWorkerIdentityActive: vi.fn(), getWorkbenchWorkerIdentity: vi.fn(),
  listWorkbenchWorkerIdentities: vi.fn(), recordWorkbenchWorkerIdentity: vi.fn(),
  revokeWorkbenchWorkerIdentity: vi.fn(), rotateWorkbenchWorkerIdentity: vi.fn(),
}));
vi.mock('../services/runtime-box/workbench-worker-identity-repository.js', () => identities);
vi.mock('../services/auth/auth.js', () => ({ authMiddleware: vi.fn(), adminMiddleware: vi.fn() }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'test-worker-api-secret' } }));

import {
  heartbeatSchema,
  registrationSchema,
  validateWorkbenchWorkerRegistrationIdentity,
  workbenchWorkerIdentityMiddleware,
} from './workbench-worker-api.js';
import { issueWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';

const capacity = { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns: 4 };
const registration = { workerId: 'worker-a', deploymentId: 'development', baseUrl: 'https://worker.internal', projectIds: ['p1'], capabilities: ['job'], capacity };

async function middlewareResult(authorization?: string) {
  const req = { headers: { authorization } } as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const next = vi.fn() as unknown as NextFunction;
  await workbenchWorkerIdentityMiddleware(req, { status, json } as unknown as Response, next);
  return { req: req as any, status, json, next };
}

describe('Workbench Worker control-plane boundary', () => {
  it('accepts only active signed Worker identity and rejects missing, inactive, or browser-like values', async () => {
    identities.assertWorkbenchWorkerIdentityActive.mockResolvedValue(undefined);
    const { token, identity } = issueWorkbenchWorkerIdentity({ workerId: 'worker-a', projectIds: ['p1'], capabilities: ['job'] });
    const accepted = await middlewareResult(`Bearer ${token}`);
    expect(accepted.next).toHaveBeenCalledOnce();
    expect(accepted.req.workbenchWorker).toEqual(identity);
    expect((await middlewareResult(undefined)).status).toHaveBeenCalledWith(401);
    expect((await middlewareResult('Bearer browser-token')).status).toHaveBeenCalledWith(401);
    identities.assertWorkbenchWorkerIdentityActive.mockRejectedValueOnce(new Error('inactive'));
    expect((await middlewareResult(`Bearer ${token}`)).status).toHaveBeenCalledWith(401);
  });

  it('prevents registration identity, Project scope, and capability scope widening', () => {
    const { identity } = issueWorkbenchWorkerIdentity({ workerId: 'worker-a', projectIds: ['p1'], capabilities: ['job'] });
    expect(validateWorkbenchWorkerRegistrationIdentity(identity, registration)).toBeNull();
    expect(validateWorkbenchWorkerRegistrationIdentity(identity, { ...registration, workerId: 'worker-b' })).toBe('WORKER_IDENTITY_MISMATCH');
    expect(validateWorkbenchWorkerRegistrationIdentity(identity, { ...registration, projectIds: ['p1', 'p2'] })).toBe('WORKER_PROJECT_SCOPE_MISMATCH');
    expect(validateWorkbenchWorkerRegistrationIdentity(identity, { ...registration, capabilities: ['job', 'browser'] })).toBe('WORKER_CAPABILITY_SCOPE_MISMATCH');
  });

  it('keeps heartbeat capacity-only and rejects unknown or excess fields', () => {
    expect(heartbeatSchema.safeParse({ workerId: 'worker-a', capacity }).success).toBe(true);
    expect(heartbeatSchema.safeParse({ workerId: 'worker-a', baseUrl: 'https://evil.internal', capacity }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ workerId: 'worker-a', capacity: { ...capacity, activeRuns: 5 } }).success).toBe(false);
    expect(registrationSchema.safeParse(registration).success).toBe(true);
  });
});
