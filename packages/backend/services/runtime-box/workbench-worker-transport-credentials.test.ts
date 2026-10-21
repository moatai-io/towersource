import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ execute: vi.fn(), queryOne: vi.fn() }));
const secrets = vi.hoisted(() => ({ getSecret: vi.fn(), getSecretForProjectBinding: vi.fn(), setSecret: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);
vi.mock('../secret/secret-store.js', () => secrets);

import {
  configureWorkbenchWorkerTransportCredential,
  resolveWorkbenchWorkerTransportToken,
  workbenchWorkerTransportSecretName,
} from '../execution/worker/worker-transport-credentials.js';

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
    secrets.getSecretForProjectBinding.mockResolvedValueOnce('resolved-value');
    await expect(resolveWorkbenchWorkerTransportToken('worker-a', 7)).resolves.toBe('resolved-value');
    expect(secrets.getSecretForProjectBinding).toHaveBeenCalledWith('WORKBENCH_WORKER_A', null);
    expect(secrets.getSecret).not.toHaveBeenCalled();
    db.queryOne.mockResolvedValueOnce(undefined);
    await expect(resolveWorkbenchWorkerTransportToken('worker-b', 7)).resolves.toBeNull();
  });

  it('never selects requester-owned or granted same-name transport secrets', async () => {
    db.queryOne.mockResolvedValue({ worker_id: 'worker-a', secret_name: 'WORKBENCH_WORKER_A' });
    secrets.getSecret.mockImplementation(async (_name, userId) => `personal-${userId}`);
    secrets.getSecretForProjectBinding.mockResolvedValue('synthetic-worker-global');
    for (const requester of [7, 8, 9]) {
      await expect(resolveWorkbenchWorkerTransportToken('worker-a', requester)).resolves.toBe('synthetic-worker-global');
    }
    expect(secrets.getSecret).not.toHaveBeenCalled();
    expect(secrets.getSecretForProjectBinding.mock.calls).toEqual([
      ['WORKBENCH_WORKER_A', null], ['WORKBENCH_WORKER_A', null], ['WORKBENCH_WORKER_A', null],
    ]);
  });

  it('fails closed when the mapped global token cannot be resolved', async () => {
    db.queryOne.mockResolvedValue({ worker_id: 'worker-a', secret_name: 'WORKBENCH_WORKER_A' });
    secrets.getSecretForProjectBinding.mockRejectedValueOnce(new Error('not found for Project binding owner'));
    await expect(resolveWorkbenchWorkerTransportToken('worker-a', 7)).rejects.toThrow('not found for Project binding owner');
    expect(secrets.getSecret).not.toHaveBeenCalled();
  });

  it('rejects invalid Worker ids and empty values before persistence', async () => {
    expect(() => workbenchWorkerTransportSecretName('../worker')).toThrow('WORKER_ID_INVALID');
    await expect(configureWorkbenchWorkerTransportCredential({ workerId: 'worker-a', token: ' ', actorUserId: 7 }))
      .rejects.toThrow('WORKER_TRANSPORT_TOKEN_EMPTY');
  });
});
