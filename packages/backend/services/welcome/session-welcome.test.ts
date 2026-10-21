import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), member: vi.fn(), access: vi.fn(), send: vi.fn(), utility: vi.fn(), defaults: vi.fn(), selectable: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock('../../config.js', () => ({ getModelDefaults: mocks.defaults, isSelectablePiModelId: mocks.selectable }));
vi.mock('../pm/project-membership-manager.js', () => ({ isProjectMember: mocks.member }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: mocks.access, canSendSessionMessage: mocks.send }));
vi.mock('../ai/utility-agent.js', () => ({ runUtilityTextTask: mocks.utility }));
import { createWelcomeService, getSessionWelcome, normalizeWelcomeLocale, parseWelcomeResponse, welcomeFallback, WelcomeAccessError } from './session-welcome.js';

const input = { userId: 7, role: 'member', projectId: 'project', sessionId: 'session', locale: 'ko' as const };
const summaries = [{ id: 'old', title: '견적 구조', summary: '가격 비교를 논의했고 결정은 하지 않았다.' }];
const responseFor = (prompt: string) => JSON.stringify({ contextLine: JSON.parse(prompt).contextLine, question: '견적을 지금 어떤 기준으로 살펴보고 싶으세요?', choices: [
  { label: '견적 기준 정리', message: '견적을 비교할 기준부터 정리하고 싶어요.' },
  { label: '새로운 일', message: '새로운 일을 설명할게요.' },
] });
function fixture(overrides = {}) {
  const deps = { authorize: vi.fn().mockResolvedValue(true), summaries: vi.fn().mockResolvedValue(summaries), generate: vi.fn().mockImplementation(responseFor), ...overrides };
  return { deps, welcome: createWelcomeService(deps) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.member.mockResolvedValue(true); mocks.access.mockResolvedValue({ allowed: true }); mocks.send.mockResolvedValue({ allowed: true });
  mocks.queryOne.mockResolvedValue({ user_id: 7, project_id: 'project', visibility: 'private', room_id: null, label: null, archived: 0, turn_count: 0, shared: false, has_messages: false });
  mocks.query.mockImplementation((sql: string) => Promise.resolve((sql.includes('SELECT LEFT(run_title') || sql.includes('FROM automations')) ? [] : summaries.map(row => ({ ...row })))); mocks.defaults.mockReturnValue({ ai_task: 'litellm-responses/mini' }); mocks.selectable.mockReturnValue(true); mocks.utility.mockImplementation(({ prompt }) => responseFor(prompt));
});

describe('welcome shape and locale', () => {
  it('has complete static locale choices without invented context', () => {
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      const fallback = welcomeFallback(locale);
      expect(fallback.contextLine).toBe(''); expect(fallback.choices).toHaveLength(3);
      expect(parseWelcomeResponse(JSON.stringify(fallback), '')).toEqual(fallback);
    }
    expect(normalizeWelcomeLocale('ko-KR')).toBe('ko'); expect(normalizeWelcomeLocale('fr')).toBe('en');
  });
  it('rejects malformed, oversized, markup, control, or fabricated context', () => {
    const valid = welcomeFallback('ko');
    expect(parseWelcomeResponse('not JSON', '')).toBeNull();
    for (const override of [{ contextLine: '완료했습니다' }, { question: '<script>evil</script>' }, { question: 'x'.repeat(161) }, { question: 'a\nb' }, { extra: true }, { choices: [{ label: 'x', message: 'y' }] }]) {
      expect(parseWelcomeResponse(JSON.stringify({ ...valid, ...override }), '')).toBeNull();
    }
    expect(parseWelcomeResponse(JSON.stringify({ ...valid, choices: [{ label: 'x', message: 'y', secret: true }, valid.choices[1]] }), '')).toBeNull();
  });
});

describe('bounded welcome service', () => {
  it('skips generation without summaries or eligible personal audience', async () => {
    const { welcome, deps } = fixture({ summaries: vi.fn().mockResolvedValue([]) });
    expect(await welcome(input)).toEqual(welcomeFallback('ko')); expect(deps.generate).not.toHaveBeenCalled();
    deps.authorize.mockResolvedValue(false); await welcome(input); expect(deps.summaries).toHaveBeenCalledTimes(1);
  });
  it('bounds prompt to twelve evidence items at two thousand characters each and reuses singleflight/cache with fresh authority', async () => {
    const { welcome, deps } = fixture({ summaries: vi.fn().mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({ ...summaries[0], id: String(i), summary: '가'.repeat(2500) }))) });
    const [a, b] = await Promise.all([welcome(input), welcome(input)]);
    expect(a).toEqual(b); expect(a.contextLine).toContain('견적 구조'); expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.generate.mock.calls[0][0]).recent).toHaveLength(12);
    expect(JSON.parse(deps.generate.mock.calls[0][0]).recent.every((item: { summary: string }) => item.summary.length === 2000)).toBe(true);
    await welcome(input); expect(deps.generate).toHaveBeenCalledTimes(1); expect(deps.authorize).toHaveBeenCalledTimes(6);
    deps.authorize.mockRejectedValue(new WelcomeAccessError(403)); await expect(welcome(input)).rejects.toMatchObject({ status: 403 });
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });
  it('uses trusted short identity and invalidates cache on profile change', async () => {
    let version = 1;
    const { welcome, deps } = fixture({ identity: async () => ({ name: '업무 동료', role: '자료 검토', version }) });
    await welcome(input); version = 2; await welcome(input);
    expect(deps.generate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(deps.generate.mock.calls[0][0]).agentIdentity).toEqual({ name: '업무 동료', role: '자료 검토' });
  });
  it('honors the kill switch after authorization without model/summary reads', async () => {
    const { welcome, deps } = fixture({ enabled: () => false });
    expect(await welcome(input)).toEqual(welcomeFallback('ko')); expect(deps.authorize).toHaveBeenCalled();
    expect(deps.summaries).not.toHaveBeenCalled(); expect(deps.generate).not.toHaveBeenCalled();
  });
  it('circuits immediate provider failure for 30 seconds across new sessions', async () => {
    let now = 0; const { welcome, deps } = fixture({ now: () => now, generate: vi.fn().mockRejectedValue(new Error('provider')) });
    await welcome(input); await welcome({ ...input, sessionId: 'new' }); expect(deps.generate).toHaveBeenCalledTimes(1);
    now = 31_000; await welcome({ ...input, sessionId: 'later' }); expect(deps.generate).toHaveBeenCalledTimes(2);
  });
  it('does not reuse cache between users/projects/locales or changed policy', async () => {
    let policy = 'mini-v1'; const { welcome, deps } = fixture({ policyKey: () => policy });
    await welcome(input); await welcome({ ...input, userId: 8 }); await welcome({ ...input, projectId: 'p2' }); await welcome({ ...input, locale: 'en' });
    policy = 'mini-v2'; await welcome(input); expect(deps.generate).toHaveBeenCalledTimes(5);
  });
  it('expires cache and bounds it to 32 entries', async () => {
    let time = 0; const { welcome, deps } = fixture({ now: () => time });
    await welcome(input); time = 31_000; await welcome(input); expect(deps.generate).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 33; i++) await welcome({ ...input, sessionId: `s-${i}` });
    await welcome(input); expect(deps.generate).toHaveBeenCalledTimes(36);
  });
  it('falls back on failure and invalid output', async () => {
    const { welcome, deps } = fixture({ generate: vi.fn().mockRejectedValue(new Error('secret provider body')) });
    expect(await welcome(input)).toEqual(welcomeFallback('ko'));
    deps.generate.mockResolvedValue('{}'); expect(await welcome({ ...input, sessionId: 'another' })).toEqual(welcomeFallback('ko'));
  });
  it('never starts late model work after summary reads exceed the budget', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: typeof summaries) => void;
      const pending = new Promise<typeof summaries>(done => { resolve = done; });
      const { welcome, deps } = fixture({ summaries: vi.fn().mockReturnValue(pending) });
      const request = welcome(input); await vi.advanceTimersByTimeAsync(6_001);
      expect(await request).toEqual(welcomeFallback('ko'));
      resolve(summaries); await vi.advanceTimersByTimeAsync(0); expect(deps.generate).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('does not start provider work when continuity reads finish after the deadline', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: typeof summaries) => void;
      const { welcome, deps } = fixture({ summaries: vi.fn(() => new Promise<typeof summaries>(r => { resolve = r; })) });
      const request = welcome(input); await vi.advanceTimersByTimeAsync(6_001);
      expect(await request).toEqual(welcomeFallback('ko'));
      resolve(summaries); await vi.advanceTimersByTimeAsync(1); expect(deps.generate).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('includes final authority reads in the timeout without leaking prepared output', async () => {
    vi.useFakeTimers();
    try {
      const { welcome } = fixture({ authorize: vi.fn().mockResolvedValueOnce(true).mockImplementation(() => new Promise(() => {})) });
      const request = welcome(input); await vi.advanceTimersByTimeAsync(6_001);
      expect(await request).toEqual(welcomeFallback('ko'));
    } finally { vi.useRealTimers(); }
  });
  it('retains at most four detached provider slots after timeout (no infinite retries)', async () => {
    vi.useFakeTimers();
    try {
      const { welcome, deps } = fixture({ generate: vi.fn().mockImplementation(() => new Promise(() => {})) });
      const requests = Array.from({ length: 8 }, (_, i) => welcome({ ...input, sessionId: `s-${i}` }));
      await vi.advanceTimersByTimeAsync(6_001);
      for (const result of await Promise.all(requests)) expect(result).toEqual(welcomeFallback('ko'));
      expect(deps.generate).toHaveBeenCalledTimes(4);
      const next = welcome(input); await vi.advanceTimersByTimeAsync(6_001); await next; expect(deps.generate).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });
  it('does not emit personalized output when target audience or source access changes during generation', async () => {
    const { welcome, deps } = fixture({ authorize: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false) });
    expect(await welcome(input)).toEqual(welcomeFallback('ko'));
    expect(deps.generate).toHaveBeenCalledTimes(1);
    const changed = fixture({ summaries: vi.fn().mockResolvedValueOnce(summaries).mockResolvedValue([]) });
    expect(await changed.welcome(input)).toEqual(welcomeFallback('ko'));
  });
});

describe('work-aware generated opening', () => {
  it('passes recorded work state and open questions, and preserves generated recap for handoff', async () => {
    const evidence = [{ id: 'prior', title: '제안서', summary: '가격 설명 논의', work: [{ title: '초안 정리', status: 'completed', outcome: '초안 작성 목표', questions: [{ title: '가격 설명', status: 'open' }], updatedAt: '2026-10-13' }] }];
    const remember = vi.fn();
    const generated = { contextLine: '초안 정리가 완료로 기록되어 있고, 가격 설명을 논의했습니다.', question: '가격 설명을 이어서 살펴볼까요?', choices: [{ label: '이어서 보기', message: '가격 설명을 이어서 살펴봐요.' }, { label: '다른 일', message: '다른 업무를 이야기할게요.' }] };
    const generate = vi.fn(async (_prompt: string) => JSON.stringify(generated));
    const welcome = createWelcomeService({ authorize: async () => true, summaries: async () => evidence, generate, remember });
    expect(await welcome(input)).toEqual(generated);
    expect(JSON.parse(generate.mock.calls[0][0] as string).recent[0].work[0].status).toBe('completed');
    expect(remember).toHaveBeenCalledWith(input, generated, evidence);
  });
});

describe('production authority and provider boundary', () => {
  it('requires live project membership, session permission, owner and matching project before generation', async () => {
    mocks.member.mockResolvedValue(false); await expect(getSessionWelcome(input)).rejects.toMatchObject({ status: 403 });
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.utility).not.toHaveBeenCalled();
    mocks.member.mockResolvedValue(true); mocks.access.mockResolvedValue({ allowed: false }); await expect(getSessionWelcome(input)).rejects.toMatchObject({ status: 403 });
    mocks.access.mockResolvedValue({ allowed: true }); mocks.queryOne.mockResolvedValue({ user_id: 8, project_id: 'project' }); await expect(getSessionWelcome(input)).rejects.toMatchObject({ status: 403 });
    mocks.queryOne.mockResolvedValue({ user_id: 7, project_id: 'other' }); await expect(getSessionWelcome(input)).rejects.toMatchObject({ status: 403 });
  });
  it.each([{ visibility: 'public' }, { shared: true }, { room_id: 'r' }, { label: 'primary' }, { has_messages: true }, { turn_count: 1 }, { archived: 1 }])('uses static fallback for ineligible target %j', async override => {
    const target = await mocks.queryOne(); mocks.queryOne.mockResolvedValue({ ...target, ...override });
    expect(await getSessionWelcome(input)).toEqual(welcomeFallback('ko')); expect(mocks.utility).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('only reads current-user/project private recent sources and passes a minimal utility prompt', async () => {
    const result = await getSessionWelcome({ ...input, sessionId: 'production-ok' });
    expect(result.contextLine).toContain('견적 구조');
    const [sql, params] = mocks.query.mock.calls[0]; expect(params).toEqual([7, 'project', 'production-ok', 'private']);
    for (const text of ['LIMIT 10', '2000) AS summary', "interval '30 days'", 's.user_id = $1', 's.project_id = $2', 'NOT EXISTS', 'session_shares', "'private'", 's.archived = 0']) expect(sql).toContain(text);
    expect(mocks.access).toHaveBeenCalledWith('old', 7, 'member');
    expect(mocks.utility).toHaveBeenCalledWith(expect.objectContaining({ model: 'litellm-responses/mini', fallbackText: '' }));
    expect(mocks.utility.mock.calls[0][0].systemPrompt).not.toContain('AGENTS.md');
  });
  it('supports Project-visible targets while excluding private source evidence', async () => {
    mocks.queryOne.mockImplementation((sql: string) => Promise.resolve(sql.includes('project_agent_profiles') ? undefined : { user_id: 7, project_id: 'project', visibility: 'project', room_id: null, label: null, archived: 0, turn_count: 0, shared: false, has_messages: false }));
    await getSessionWelcome({ ...input, sessionId: 'project-visible' });
    const sourceRead = mocks.query.mock.calls.find(([sql]) => sql.includes('FROM sessions s'))!;
    expect(sourceRead[1][3]).toBe('project');
    expect(sourceRead[0]).toContain("$4 = 'private'");
    expect(mocks.utility).toHaveBeenCalled();
  });
  it('can start from automation evidence alone without leaking prompt or error text', async () => {
    mocks.query.mockImplementation((sql: string) => Promise.resolve(sql.includes('FROM automations') ? [{ id: 'auto-1', title: '주간 브리핑', enabled: true, status: 'idle', last_status: 'failed', last_run_at: '2026-10-13', next_run_at: null }] : []));
    await getSessionWelcome({ ...input, sessionId: 'automation-only' });
    const payload = JSON.parse(mocks.utility.mock.calls[0][0].prompt);
    expect(payload.recent[0].summary).toContain('failed');
    const sql = mocks.query.mock.calls.find(([sql]) => sql.includes('FROM automations'))![0];
    expect(sql).toContain('user_id = $1 AND project_id = $2');
    expect(sql).not.toContain('last_error');
    expect(sql).toContain('description, prompt, trigger_type');
  });
  it('uses the account display name without inventing a shortened address', async () => {
    mocks.queryOne.mockImplementation((sql: string) => Promise.resolve(sql.includes('FROM users') ? { display_name: '데모 사용자' } : sql.includes('project_agent_profiles') ? undefined : { user_id: 7, project_id: 'project', visibility: 'private', room_id: null, label: null, archived: 0, turn_count: 0, shared: false, has_messages: false }));
    await getSessionWelcome({ ...input, sessionId: 'named-opening' });
    expect(JSON.parse(mocks.utility.mock.calls[0][0].prompt).agentIdentity.userName).toBe('데모 사용자');
  });
  it('reads only profile display name/role/version (not instruction/skills)', async () => {
    mocks.queryOne.mockImplementation((sql: string) => sql.includes('project_agent_profiles')
      ? Promise.resolve({ display_name: '분석 동료', role: '근거 검토', instruction_version: 6 })
      : Promise.resolve({ user_id: 7, project_id: 'project', visibility: 'private', archived: 0, turn_count: 0 }));
    await getSessionWelcome({ ...input, sessionId: 'profile' });
    expect(JSON.parse(mocks.utility.mock.calls[0][0].prompt).agentIdentity).toEqual({ name: '분석 동료', role: '근거 검토' });
  });
  it('skips disabled or non-Router model without substitution', async () => {
    mocks.selectable.mockReturnValue(false); await getSessionWelcome({ ...input, sessionId: 'disabled-model' }); expect(mocks.utility).not.toHaveBeenCalled();
    mocks.selectable.mockReturnValue(true); mocks.defaults.mockReturnValue({ ai_task: 'claude-haiku-4-5-20251001' });
    await getSessionWelcome({ ...input, sessionId: 'wrong-model' }); expect(mocks.utility).not.toHaveBeenCalled();
  });
});
