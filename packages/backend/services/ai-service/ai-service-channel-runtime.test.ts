import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const queryOne = vi.fn();
const assertAIServiceActivationReady = vi.fn();
const appendServiceMessage = vi.fn();
const createActiveChannelConversation = vi.fn();
const runAIServicePreview = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ query, queryOne }));
vi.mock('./activation-gate.js', () => ({ assertAIServiceActivationReady }));
vi.mock('./ai-service-manager.js', () => ({ appendServiceMessage, createActiveChannelConversation }));
vi.mock('./ai-service-preview-runtime.js', () => ({ runAIServicePreview }));

const { createAIServiceChannelConversation, runAIServiceChannelTurn } = await import('./ai-service-channel-runtime.js');

const active = {
  service_id: 'svc-1', deployment_id: 'dep-1', channel_id: 'channel-1', tenant_key: 'tenant-1', user_key: 'user-1',
  status: 'open', channel_status: 'enabled', active_deployment_id: 'dep-1', service_status: 'active',
  current_deployment_id: 'dep-1', deployment_status: 'active',
};
const response = { text: 'answer', mode: 'harness-preview', citations: [], provenance: { harnessId: 'quick-web-research' } };

describe('AI Service Channel pinned runtime', () => {
  beforeEach(() => { vi.clearAllMocks(); query.mockResolvedValue([]); });

  it('creates a Conversation only through the active Channel resolver', async () => {
    createActiveChannelConversation.mockResolvedValue({ id: 'conv-1', deploymentId: 'dep-1' });
    await expect(createAIServiceChannelConversation({ serviceId: 'svc-1', channelId: 'channel-1', tenantKey: ' tenant-1 ', userKey: ' user-1 ' }))
      .resolves.toEqual({ id: 'conv-1', deploymentId: 'dep-1' });
    expect(createActiveChannelConversation).toHaveBeenCalledWith({ serviceId: 'svc-1', channelId: 'channel-1', tenantKey: 'tenant-1', userKey: 'user-1' });
  });

  it('executes an isolated tenant/user Conversation through the exact evaluated Deployment', async () => {
    queryOne.mockResolvedValue(active);
    runAIServicePreview.mockResolvedValue(response);
    const result = await runAIServiceChannelTurn({ serviceId: 'svc-1', channelId: 'channel-1', conversationId: 'conv-1', tenantKey: 'tenant-1', userKey: 'user-1', prompt: 'hello', userId: 7 });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('x.tenant_key=$4 AND x.user_key=$5'), ['conv-1', 'svc-1', 'channel-1', 'tenant-1', 'user-1']);
    expect(assertAIServiceActivationReady).toHaveBeenCalledWith('dep-1', 'svc-1');
    expect(runAIServicePreview).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: 'dep-1', conversationId: 'conv-1', prompt: 'hello', recordEvaluation: false, runtimeMode: 'channel', conversationKnowledgeSnapshot: undefined }));
    expect(appendServiceMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ deploymentId: 'dep-1', role: 'user' }));
    expect(appendServiceMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ deploymentId: 'dep-1', role: 'assistant' }));
    expect(result).toBe(response);
  });

  it('fails closed for a different tenant or user before evaluating or executing', async () => {
    queryOne.mockResolvedValue(undefined);
    await expect(runAIServiceChannelTurn({ serviceId: 'svc-1', channelId: 'channel-1', conversationId: 'conv-1', tenantKey: 'other', userKey: 'user-1', prompt: 'hello', userId: 7 }))
      .rejects.toThrow('not found or inaccessible');
    expect(assertAIServiceActivationReady).not.toHaveBeenCalled();
    expect(runAIServicePreview).not.toHaveBeenCalled();
    expect(appendServiceMessage).not.toHaveBeenCalled();
  });

  it('continues an existing Conversation on its superseded pinned Deployment after a new version activates', async () => {
    queryOne.mockResolvedValue({ ...active, deployment_status: 'superseded', active_deployment_id: 'dep-2', current_deployment_id: 'dep-2' });
    runAIServicePreview.mockResolvedValue(response);
    await expect(runAIServiceChannelTurn({ serviceId: 'svc-1', channelId: 'channel-1', conversationId: 'conv-1', tenantKey: 'tenant-1', userKey: 'user-1', prompt: 'continue', userId: 7 }))
      .resolves.toBe(response);
    expect(assertAIServiceActivationReady).toHaveBeenCalledWith('dep-1', 'svc-1');
    expect(runAIServicePreview).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: 'dep-1', conversationId: 'conv-1' }));
  });

  it.each([
    ['disabled Channel', { channel_status: 'disabled' }],
    ['paused Service', { service_status: 'paused' }],
    ['revoked Deployment', { deployment_status: 'revoked' }],
    ['missing active Deployment', { active_deployment_id: null }],
    ['inconsistent active pointers', { active_deployment_id: 'dep-2', current_deployment_id: 'dep-3' }],
  ])('fails closed for %s before runtime execution', async (_label, override) => {
    queryOne.mockResolvedValue({ ...active, ...override });
    await expect(runAIServiceChannelTurn({ serviceId: 'svc-1', channelId: 'channel-1', conversationId: 'conv-1', tenantKey: 'tenant-1', userKey: 'user-1', prompt: 'hello', userId: 7 }))
      .rejects.toThrow('runtime is not active');
    expect(assertAIServiceActivationReady).not.toHaveBeenCalled();
    expect(runAIServicePreview).not.toHaveBeenCalled();
  });

  it('does not persist a user message when the evaluated runtime contract is stale', async () => {
    queryOne.mockResolvedValue(active);
    assertAIServiceActivationReady.mockRejectedValue(new Error('Preview evaluation is stale'));
    await expect(runAIServiceChannelTurn({ serviceId: 'svc-1', channelId: 'channel-1', conversationId: 'conv-1', tenantKey: 'tenant-1', userKey: 'user-1', prompt: 'hello', userId: 7 }))
      .rejects.toThrow('evaluation is stale');
    expect(appendServiceMessage).not.toHaveBeenCalled();
    expect(runAIServicePreview).not.toHaveBeenCalled();
  });
});
