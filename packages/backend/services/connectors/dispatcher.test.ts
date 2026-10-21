import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ claim: vi.fn(), settle: vi.fn(), getProject: vi.fn(), getUserRole: vi.fn(), canCreate: vi.fn(), createTask: vi.fn(), spawnTask: vi.fn(), broadcast: vi.fn() }));
vi.mock('./store.js', () => ({ WebhookEventStore: class { claim = mocks.claim; settle = mocks.settle; } }));
vi.mock('../pm/project-manager.js', () => ({ getProject: mocks.getProject }));
vi.mock('../pm/project-access.js', () => ({ canCreateInProject: mocks.canCreate }));
vi.mock('../auth/auth.js', () => ({ getUserRole: mocks.getUserRole }));
vi.mock('../task/task-manager.js', () => ({ createTask: mocks.createTask }));
vi.mock('../task/task-runner.js', () => ({ spawnTask: mocks.spawnTask }));
vi.mock('../../routes/ws-handler.js', () => ({ broadcastToAll: mocks.broadcast }));
import { dispatchOneWebhookEvent } from './dispatcher.js';

const claim = { id: 'e1', connectorId: 'linear-main', provider: 'linear', claimId: 'c1', attempts: 1,
  event: { provider: 'linear', deliveryId: 'd1', eventType: 'Issue', action: 'update', occurredAt: 1, resourceId: 'i1' } };

describe('Webhook Dispatcher', () => {
  it('settles missing bindings for review without executing', async () => {
    mocks.claim.mockResolvedValueOnce(claim); mocks.settle.mockResolvedValueOnce(undefined);
    await expect(dispatchOneWebhookEvent({} as any, () => null)).resolves.toBe(true);
    expect(mocks.settle).toHaveBeenCalledWith(claim, { status: 'needs_review', reason: 'webhook_dispatch_binding_missing' });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
  it('resolves, rechecks run-as authority, creates one Task, then settles the claim', async () => {
    const resolver = { provider: 'linear', resolve: vi.fn(async () => ({ kind: 'run' as const, route: 'research' as const, title: 'Task', prompt: 'Prompt', resourceKey: 'TOW-8' })) };
    mocks.claim.mockResolvedValueOnce(claim); mocks.getProject.mockResolvedValueOnce({ id: 'p1', rootPath: '/workspace/p1', lifecycleStatus: 'active', archived: false });
    mocks.getUserRole.mockResolvedValueOnce('member'); mocks.canCreate.mockResolvedValueOnce({ allowed: true });
    mocks.createTask.mockResolvedValueOnce({ id: 't1' }); mocks.settle.mockResolvedValueOnce(undefined); mocks.spawnTask.mockResolvedValueOnce(undefined);
    await expect(dispatchOneWebhookEvent({} as any, () => ({ connectorId: 'linear-main', projectId: 'p1', runAsUserId: 7, resolver }))).resolves.toBe(true);
    expect(mocks.canCreate).toHaveBeenCalledWith('p1', 7, 'member');
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.settle).toHaveBeenCalledWith(claim, expect.objectContaining({ status: 'task_created', taskId: 't1' }));
  });
});
