import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ execute: vi.fn(), queryOne: vi.fn() }));
const secrets = vi.hoisted(() => ({ getSecret: vi.fn(), setSecret: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);
vi.mock('../secret/secret-store.js', () => secrets);

import {
  configureWorkbenchWorkerTransportCredential,
  resolveWorkbenchWorkerTransportToken,
  workbenchWorkerTransportSecretName,
} from './workbench-worker-transport-credentials.js';

beforeEach(() => vi.clearAllMocks());

describe('Workbench Worker transport credentials', () => {
  it('encrypts token through Secret Store and persists only the derived secret name', async () => {
    const secretName = workbenchWorkerTransportSecretName('worker-a');
    db.queryOne.mockResolvedValue({ worker_id: 'worker-a', secret_name: secretName });
    await configureWorkbenchWorkerTransportCredential({ workerId: 'worker-a', token: 'sensitive-value', actorUserId: 7 });
    expect(secrets.setSecret).toHaveBeenCalledWith(expect.objectContaining({ name: secretName, value: 'sensitive-value', scope: 'global' }));
    expect(JSON.stringify(db.queryOne.mock.calls)).not.toContain('sensitive-value');
    expect(db.queryOne.mock.calls[0][1]).toEqual(['worker-a', secretName, 7]);
  });

  it('resolves only the exact Worker mapping and returns null when unconfigured', async () => {
    db.queryOne.mockResolvedValueOnce({ worker_id: 'worker-a', secret_name: 'WORKBENCH_WORKER_A' });
    secrets.getSecret.mockResolvedValueOnce('resolved-value');
    await expect(resolveWorkbenchWorkerTransportToken('worker-a', 7)).resolves.toBe('resolved-value');
    expect(secrets.getSecret).toHaveBeenCalledWith('WORKBENCH_WORKER_A', 7);
    db.queryOne.mockResolvedValueOnce(undefined);
    await expect(resolveWorkbenchWorkerTransportToken('worker-b', 7)).resolves.toBeNull();
  });

  it('rejects invalid Worker ids and empty values before persistence', async () => {
    expect(() => workbenchWorkerTransportSecretName('../worker')).toThrow('WORKER_ID_INVALID');
    await expect(configureWorkbenchWorkerTransportCredential({ workerId: 'worker-a', token: ' ', actorUserId: 7 }))
      .rejects.toThrow('WORKER_TRANSPORT_TOKEN_EMPTY');
  });
});
