import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();
const assertAIServiceActivationReady = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne, execute, transaction: async (fn: any) => fn({}), withClient: () => ({ queryOne, execute }) }));
vi.mock('./activation-gate.js', () => ({ assertAIServiceActivationReady }));

const { activateDeployment, createActiveChannelConversation, deploymentSnapshotHash, nextDeploymentStatus, pauseService, revokeDeployment, rollbackDeployment } = await import('./ai-service-manager.js');

describe('AI service state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAIServiceActivationReady.mockResolvedValue(undefined);
  });

  it('enforces transitions and terminal revoke', () => {
    expect(nextDeploymentStatus('draft', 'submit_review')).toBe('review');
    expect(nextDeploymentStatus('review', 'approve')).toBe('approved');
    expect(() => nextDeploymentStatus('revoked', 'activate')).toThrow(/Cannot activate/);
    expect(() => nextDeploymentStatus('draft', 'activate')).toThrow(/Cannot activate/);
  });

  it('hashes reordered snapshot objects identically', () => {
    const a = { sourceSnapshot: { b: 2, a: 1 }, policySnapshot: {}, experienceSnapshot: {}, evaluationSnapshot: {} };
    const b = { sourceSnapshot: { a: 1, b: 2 }, policySnapshot: {}, experienceSnapshot: {}, evaluationSnapshot: {} };
    expect(deploymentSnapshotHash(a)).toBe(deploymentSnapshotHash(b));
  });

  it('gates activation before superseding and repointing', async () => {
    queryOne.mockResolvedValue({ service_id: 'svc', status: 'approved' });
    execute.mockResolvedValue({ changes: 1 });
    await activateDeployment('dep2', 7, 'deploy', 'svc');
    expect(assertAIServiceActivationReady).toHaveBeenCalledWith('dep2', 'svc');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status='superseded'"), ['svc', 'dep2']);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('current_deployment_id=$1'), ['dep2', 'svc']);
  });

  it('fails closed before mutation when the activation gate rejects', async () => {
    assertAIServiceActivationReady.mockRejectedValue(new Error('stale evaluation'));
    await expect(activateDeployment('dep2', 7, 'deploy', 'svc')).rejects.toThrow('stale evaluation');
    expect(queryOne).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a deployment that belongs to a different service', async () => {
    queryOne.mockResolvedValue({ service_id: 'other', status: 'approved' });
    execute.mockResolvedValue({ changes: 1 });
    await expect(activateDeployment('dep2', 7, 'deploy', 'svc')).rejects.toThrow('does not belong to AI service');
    expect(execute).not.toHaveBeenCalled();
  });

  it('atomically creates a serving Conversation from an enabled Channel active pointer', async () => {
    queryOne.mockResolvedValue({ id: 'conv-1', deployment_id: 'dep-1' });
    await expect(createActiveChannelConversation({ serviceId: 'svc', channelId: 'channel-1', tenantKey: 'tenant-1', userKey: 'user-1' }))
      .resolves.toEqual({ id: 'conv-1', deploymentId: 'dep-1' });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("c.status='enabled'"), expect.arrayContaining(['channel-1', 'tenant-1', 'user-1', 'svc']));
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("d.status='active'"), expect.any(Array));
  });

  it('rejects Conversation creation when Channel has no active Deployment', async () => {
    queryOne.mockResolvedValue(undefined);
    await expect(createActiveChannelConversation({ serviceId: 'svc', channelId: 'channel-1', tenantKey: 'tenant-1', userKey: 'user-1' }))
      .rejects.toThrow('not enabled with an active Deployment');
  });

  it('pause disables channels', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await pauseService('svc', 7);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status='disabled'"), ['svc']);
  });

  it('rollback records provenance after passing the gate', async () => {
    queryOne.mockResolvedValue({ service_id: 'svc', status: 'superseded' });
    execute.mockResolvedValue({ changes: 1 });
    await rollbackDeployment('dep1', 7);
    expect(assertAIServiceActivationReady).toHaveBeenCalledWith('dep1', undefined);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ai_service_audit_events'), ['svc', 'dep1', 7, 'deployment_rollback', JSON.stringify({ reason: 'rollback' })]);
  });

  it('revoke blocks channels and pauses current service', async () => {
    queryOne.mockResolvedValue({ service_id: 'svc', status: 'active' });
    execute.mockResolvedValue({ changes: 1 });
    expect(await revokeDeployment('dep1', 7)).toBe('revoked');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status='blocked'"), ['dep1']);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status='paused'"), ['svc', 'dep1']);
  });
});
