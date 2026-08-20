import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const createSession = vi.fn();
const deleteSession = vi.fn();
const resolvePublishedHarnessReference = vi.fn();
const engineRun = vi.fn();
const engineDispose = vi.fn();
const getEngine = vi.fn(async () => ({ run: engineRun, dispose: engineDispose }));
const recordPassedRuntimeEvaluation = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({ queryOne }));
const claimEngineSessionId = vi.fn();
const updateSession = vi.fn();
const saveMessage = vi.fn();
const updateMessageContent = vi.fn();
const attachToolResultInDb = vi.fn();
const updateMessageMetrics = vi.fn();
const markAgentTurnCheckpoint = vi.fn();
vi.mock('../session/session-manager.js', () => ({ createSession, deleteSession, claimEngineSessionId, updateSession }));
vi.mock('../message-store.js', () => ({ saveMessage, updateMessageContent, attachToolResultInDb, updateMessageMetrics, markAgentTurnCheckpoint }));
vi.mock('../harness/harness-store.js', () => ({ resolvePublishedHarnessReference }));
vi.mock('../../engines/index.js', () => ({ getEngine }));
vi.mock('./activation-gate.js', () => ({ recordPassedRuntimeEvaluation }));

const { runAIServicePreview } = await import('./ai-service-preview-runtime.js');

const harness = Object.freeze({
  id: 'quick-web-research', version: 1, runtimeProfileId: 'web-only', runtimeProfileVersion: 1,
  engine: 'pi' as const, defaultModel: 'litellm-responses/smart', allowedModels: ['litellm-responses/smart'],
  prompt: { includePlatformKernel: true as const, includeAgentIdentity: true, includeProjectInstructions: false, includeMemory: false, includeSkills: false, fragments: [] },
  capabilityIds: ['web.fetch', 'web.search'], sandboxMode: 'none' as const, networkMode: 'platform-default' as const, source: 'database' as const,
});

const deployment = {
  service_id: 'svc-1', owner_project_id: 'project-1', owner_user_id: 7, service_name: 'Public Researcher', root_path: '/workspace/project-1', snapshot_hash: 'deployment-hash',
  source_snapshot: { kind: 'none', version: 1, refs: [] },
  policy_snapshot: { harnessBinding: { harnessId: 'quick-web-research', harnessVersion: 1, runtimeProfileId: 'web-only', runtimeProfileVersion: 1, engine: 'pi', model: 'litellm-responses/smart', status: 'published' } },
  experience_snapshot: { identity: { displayName: 'Public Researcher', role: 'Public web research', promise: 'Cited answers', instruction: 'Use only public sources.', sourceAgentProjectId: 'project-1', sourceAgentProfileVersion: 4 } },
};

function messages(items: any[]) {
  return async function* () { for (const item of items) yield item; };
}

describe('AI Service Preview pinned Harness runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePublishedHarnessReference.mockResolvedValue(harness);
  });

  it('runs an existing private runtime Session with no filesystem authority and returns Harness provenance', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation(() => messages([
      { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm1', content: [
        { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'Tower' } },
        { type: 'text', text: '확인했습니다.' },
      ] },
      { type: 'engine_done', sessionId: 'runtime-session-1', model: 'litellm-responses/smart' },
    ])());

    const result = await runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '찾아줘', userId: 7 });

    expect(engineRun).toHaveBeenCalledWith('runtime-session-1', expect.stringContaining('User request:\n찾아줘'), expect.objectContaining({
      harnessId: 'quick-web-research', accessiblePaths: [], readOnlyPaths: [], denyImplicitBash: true, channelSafeToolsOnly: true,
      serviceIdentityPrompt: expect.stringContaining('You are **Public Researcher**, a separate deployed Service Agent.'),
    }), expect.any(Object));
    expect(result).toMatchObject({ text: '확인했습니다.', mode: 'harness-preview', provenance: {
      harnessId: 'quick-web-research', harnessVersion: 1, runtimeProfileId: 'web-only', promptBundleHash: expect.stringMatching(/^[a-f0-9]{64}$/), toolCount: 2,
      tools: [{ name: 'WebSearch', input: { query: 'Tower' } }], deploymentSnapshotHash: 'deployment-hash',
    } });
    expect(createSession).not.toHaveBeenCalled();
    expect(saveMessage).toHaveBeenCalledWith('runtime-session-1', expect.objectContaining({ role: 'user', username: 'AI Service Preview' }));
    expect(markAgentTurnCheckpoint).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ status: 'started', engine: 'pi' }));
    expect(markAgentTurnCheckpoint).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'completed', engine: 'pi' }));
    expect(recordPassedRuntimeEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', evaluatedByUserId: 7,
      provenance: expect.objectContaining({ deploymentSnapshotHash: 'deployment-hash', promptBundleHash: expect.stringMatching(/^[a-f0-9]{64}$/), toolCount: 2 }),
    }));
  });

  it('injects immutable Knowledge and returns only citations verified against same-turn knowledge_read evidence', async () => {
    queryOne.mockResolvedValueOnce({ ...deployment, source_snapshot: { kind: 'knowledge', version: 1, refs: [{ path: 'knowledge/guide.md', title: 'guide', sha256: 'abc', content: '# 정책\n환불은 7일 이내입니다.\n신청서를 제출하세요.' }] } }).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation((_sessionId, _prompt, _opts, callbacks) => (async function* () {
      yield { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm1', content: [{ type: 'tool_use', id: 'read-1', name: 'knowledge_read', input: { documentId: 'doc_test', lineStart: 1, lineEnd: 3 } }] };
      await callbacks.attachToolResult('read-1', JSON.stringify({ documentId: 'doc_test', path: 'knowledge/guide.md', title: 'guide', sha256: 'abc', lineStart: 1, lineEnd: 3, content: '# 정책\n환불은 7일 이내입니다.\n신청서를 제출하세요.', citation: 'knowledge/guide.md#L1-L3' }));
      yield { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm2', content: [{ type: 'text', text: '환불은 7일 이내입니다. [K1: knowledge/guide.md#L2-L2]' }] };
    })());

    const result = await runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '환불 기한?', userId: 7 });

    expect(engineRun).toHaveBeenCalledWith('runtime-session-1', expect.stringContaining('Use knowledge_search to find relevant passages'), expect.objectContaining({
      accessiblePaths: [], readOnlyPaths: [], serviceKnowledgeSnapshot: expect.objectContaining({ kind: 'knowledge' }),
    }), expect.any(Object));
    expect(engineRun.mock.calls[0]?.[1]).not.toContain('환불은 7일 이내입니다.');
    expect(result.provenance.toolCount).toBe(4);
    expect(result.provenance.knowledgeCitationValidation).toEqual({ readCount: 1, verifiedCount: 1, invalidCount: 0 });
    expect(result.citations).toEqual([expect.objectContaining({ path: 'knowledge/guide.md', citedLineStart: 2, citedLineEnd: 2, label: 'K1' })]);
  });

  it('captures knowledge_read evidence even when the tool result callback arrives before the assistant tool_use event', async () => {
    queryOne.mockResolvedValueOnce({ ...deployment, source_snapshot: { kind: 'knowledge', version: 1, refs: [{ path: 'work/research.md', title: 'research', sha256: 'abc', content: 'one\ntwo\nthree' }] } }).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation((_sessionId, _prompt, _opts, callbacks) => (async function* () {
      await callbacks.attachToolResult('read-before-event', JSON.stringify({ documentId: 'doc_test', path: 'work/research.md', title: 'research', sha256: 'abc', lineStart: 1, lineEnd: 42, content: 'bounded snapshot content', citation: 'work/research.md#L1-L42' }));
      yield { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm1', content: [{ type: 'tool_use', id: 'read-before-event', name: 'knowledge_read', input: { documentId: 'doc_test', lineStart: 1, lineEnd: 42 } }] };
      yield { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm2', content: [{ type: 'text', text: '요약입니다. [K1: work/research.md#L1-L42]' }] };
    })());

    const result = await runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '요약', userId: 7 });
    expect(result.citations).toEqual([expect.objectContaining({ path: 'work/research.md', citedLineStart: 1, citedLineEnd: 42 })]);
    expect(result.provenance.knowledgeCitationValidation).toEqual({ readCount: 1, verifiedCount: 1, invalidCount: 0 });
  });

  it('rejects a Knowledge citation outside the lines returned by knowledge_read', async () => {
    queryOne.mockResolvedValueOnce({ ...deployment, source_snapshot: { kind: 'knowledge', version: 1, refs: [{ path: 'knowledge/guide.md', title: 'guide', sha256: 'abc', content: 'one\ntwo\nthree' }] } }).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation((_sessionId, _prompt, _opts, callbacks) => (async function* () {
      yield { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm1', content: [{ type: 'tool_use', id: 'read-1', name: 'knowledge_read', input: { documentId: 'doc_test', lineStart: 1, lineEnd: 3 } }] };
      await callbacks.attachToolResult('read-1', JSON.stringify({ documentId: 'doc_test', path: 'knowledge/guide.md', title: 'guide', sha256: 'abc', lineStart: 1, lineEnd: 3, content: 'one\ntwo\nthree', citation: 'knowledge/guide.md#L1-L3' }));
      yield { type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm2', content: [{ type: 'text', text: '근거입니다. [K1: knowledge/guide.md#L4-L8]' }] };
    })());

    await expect(runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7 }))
      .rejects.toMatchObject({ code: 'AI_SERVICE_KNOWLEDGE_CITATION_INVALID', publicMessage: '답변의 출처를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', message: expect.stringContaining('knowledge/guide.md#L4-L8') });
    expect(markAgentTurnCheckpoint).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'failed', error: expect.stringContaining('serviceId=svc-1 deploymentId=dep-1 conversationId=conv-1') }));
    expect(recordPassedRuntimeEvaluation).not.toHaveBeenCalled();
  });

  it('pins a new private Session with the exact Deployment Harness tuple', async () => {
    queryOne
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ runtime_session_id: null })
      .mockResolvedValueOnce({ runtime_session_id: 'runtime-session-new' });
    createSession.mockResolvedValue({ id: 'runtime-session-new' });
    engineRun.mockImplementation(() => messages([{ type: 'assistant', sessionId: 'runtime-session-new', msgId: 'm1', content: [{ type: 'text', text: '완료' }] }])());

    await runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7 });

    expect(createSession).toHaveBeenCalledWith(expect.stringContaining('AI Service Preview'), '/workspace/project-1', 7, 'project-1', 'pi', null, null, null, 'ai_service_preview', 'litellm-responses/smart', {
      visibility: 'private', harness: { id: 'quick-web-research', version: 1, runtimeProfileId: 'web-only', runtimeProfileVersion: 1 },
    });
  });

  it('reports a durable claim denial instead of a generic empty response', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation(() => messages([
      { type: 'engine_done', sessionId: 'runtime-session-1', outcome: 'claim_denied' },
    ])());

    await expect(runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7 }))
      .rejects.toMatchObject({ message: 'AI Service runtime completed without assistant text (engine outcome: claim_denied)', code: 'AI_SERVICE_RUNTIME_CLAIM_DENIED', retryable: false });
    expect(markAgentTurnCheckpoint).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'failed', error: expect.stringContaining('claim_denied') }));
    expect(recordPassedRuntimeEvaluation).not.toHaveBeenCalled();
  });

  it('surfaces a recoverable Provider failure instead of replacing it with an empty-response error', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation(() => messages([
      { type: 'engine_error', sessionId: 'runtime-session-1', message: 'upstream_unavailable: Request to upstream timed out', recoverable: true, retryable: true },
      { type: 'engine_done', sessionId: 'runtime-session-1' },
    ])());

    await expect(runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7 }))
      .rejects.toMatchObject({ message: 'upstream_unavailable: Request to upstream timed out', retryable: true });
    expect(recordPassedRuntimeEvaluation).not.toHaveBeenCalled();
  });

  it('does not mint activation evidence for serving traffic', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation(() => messages([{ type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm1', content: [{ type: 'text', text: 'served' }] }])());

    const result = await runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7, recordEvaluation: false, runtimeMode: 'channel' });

    expect(result.text).toBe('served');
    expect(saveMessage).toHaveBeenCalledWith('runtime-session-1', expect.objectContaining({ role: 'user', username: '외부 사용자' }));
    expect(engineRun).toHaveBeenCalledWith('runtime-session-1', expect.stringContaining('isolated AI Service Channel'), expect.any(Object), expect.any(Object));
    expect(recordPassedRuntimeEvaluation).not.toHaveBeenCalled();
  });

  it('creates serving traffic as a deployment Session in the reserved deck', async () => {
    queryOne
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ runtime_session_id: null })
      .mockResolvedValueOnce({ runtime_session_id: 'runtime-session-new' });
    createSession.mockResolvedValue({ id: 'runtime-session-new' });
    engineRun.mockImplementation(() => messages([{ type: 'assistant', sessionId: 'runtime-session-new', msgId: 'm1', content: [{ type: 'text', text: 'served' }] }])());

    await runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', recordEvaluation: false, runtimeMode: 'channel' });

    expect(createSession).toHaveBeenCalledWith(expect.stringContaining('Public Researcher · 외부 대화'), '/workspace/project-1', 7, 'project-1', 'pi', null, null, null, '배포 세션', 'litellm-responses/smart', expect.objectContaining({ visibility: 'project' }));
    expect(updateSession).toHaveBeenCalledWith('runtime-session-new', { kind: 'deployment' });
  });

  it('fails closed when runtime emits a tool outside the Harness surface', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce({ runtime_session_id: 'runtime-session-1' });
    engineRun.mockImplementation(() => messages([{ type: 'assistant', sessionId: 'runtime-session-1', msgId: 'm1', content: [
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'secret' } }, { type: 'text', text: 'bad' },
    ] }])());

    await expect(runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7 }))
      .rejects.toThrow('unexpected tools read');
    expect(recordPassedRuntimeEvaluation).not.toHaveBeenCalled();
  });

  it('rejects draft Harness bindings before invoking an engine', async () => {
    queryOne.mockResolvedValueOnce({ ...deployment, policy_snapshot: { harnessBinding: { ...(deployment.policy_snapshot.harnessBinding), status: 'draft' } } });
    await expect(runAIServicePreview({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', prompt: '질문', userId: 7 }))
      .rejects.toThrow('Only a published Harness');
    expect(getEngine).not.toHaveBeenCalled();
  });
});
