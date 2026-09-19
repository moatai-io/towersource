// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from './session-store';

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    visibleChatSessionId: null,
    streamingSessions: new Set(),
    unreadSessions: new Set(),
    turnTerminalBySession: {},
    recentlyReadSessionUntil: {},
    lastTurnTextBySession: {},
    sidebarOpen: true,
    sidebarTab: 'sessions',
    searchQuery: '',
    isMobile: false,
    mobileTab: 'ai',
    mobileContextOpen: false,
    mobileTabBeforeContext: 'ai',
    activeView: 'chat',
    hydratedProjectSessionIds: new Set(),
    projectSessionsLoading: new Set(),
  });
});

function session(id: string, projectId: string, updatedAt: string): any {
  return {
    id,
    projectId,
    name: id,
    cwd: '/workspace',
    tags: [],
    favorite: false,
    totalCost: 0,
    totalTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('session list scope reconciliation', () => {
  it('preserves fully hydrated project sessions when the global recent window refreshes', () => {
    const recent = session('recent', 'project-b', '2026-08-20T02:00:00Z');
    const oldProjectSession = session('old-project-session', 'project-a', '2025-01-01T00:00:00Z');
    useSessionStore.setState({
      sessions: [recent, oldProjectSession],
      hydratedProjectSessionIds: new Set(['project-a']),
    } as any);

    useSessionStore.getState().setRecentSessions([
      session('recent-next', 'project-b', '2026-08-20T03:00:00Z'),
    ]);

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      'recent-next',
      'old-project-session',
    ]);
  });

  it('preserves the active deep-linked session outside both the recent window and hydrated projects', () => {
    const active = session('active-deep-link', 'project-c', '2024-01-01T00:00:00Z');
    useSessionStore.setState({ sessions: [active], activeSessionId: active.id } as any);

    useSessionStore.getState().setRecentSessions([
      session('recent', 'project-b', '2026-08-20T03:00:00Z'),
    ]);

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      'recent',
      'active-deep-link',
    ]);
  });

  it('preserves a session created while an older recent-window request was in flight', () => {
    const requestStartedAt = new Date('2026-08-20T02:00:00Z').getTime();
    useSessionStore.setState({
      sessions: [session('created-during-request', 'project-a', '2026-08-20T02:00:01Z')],
    } as any);

    useSessionStore.getState().setRecentSessions([
      session('server-snapshot', 'project-b', '2026-08-20T01:59:59Z'),
    ], { requestedAt: requestStartedAt });

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      'created-during-request',
      'server-snapshot',
    ]);
  });

  it('still removes an old non-hydrated session omitted from a fresh recent window', () => {
    const requestStartedAt = new Date('2026-08-20T02:00:00Z').getTime();
    useSessionStore.setState({
      sessions: [session('stale-local', 'project-a', '2026-08-20T01:00:00Z')],
    } as any);

    useSessionStore.getState().setRecentSessions([], { requestedAt: requestStartedAt });

    expect(useSessionStore.getState().sessions).toEqual([]);
  });

  it('replaces one hydrated project scope authoritatively and deduplicates concurrent requests', async () => {
    const projectSession = session('project-session', 'project-a', '2026-08-20T01:00:00Z');
    let resolveFetch!: (value: unknown) => void;
    global.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })) as any;

    const first = useSessionStore.getState().hydrateProjectSessions('project-a');
    const second = useSessionStore.getState().hydrateProjectSessions('project-a');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: async () => [projectSession] });
    await Promise.all([first, second]);

    expect(useSessionStore.getState().sessions).toEqual([projectSession]);
    expect(useSessionStore.getState().hydratedProjectSessionIds.has('project-a')).toBe(true);
    expect(useSessionStore.getState().projectSessionsLoading.has('project-a')).toBe(false);
  });

  it('allows a failed project hydration to be retried', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => [session('retry-session', 'project-a', '2026-08-20T01:00:00Z')] }) as any;

    await useSessionStore.getState().hydrateProjectSessions('project-a');
    expect(useSessionStore.getState().hydratedProjectSessionIds.has('project-a')).toBe(false);

    await useSessionStore.getState().hydrateProjectSessions('project-a');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().sessions[0].id).toBe('retry-session');
  });
});

describe('mobile navigation surface transitions', () => {
  it('opens Files atomically without retaining the AI Team surface', () => {
    useSessionStore.setState({ mobileContextOpen: true, mobileTab: 'ai', sidebarTab: 'sessions', sidebarOpen: false, activeView: 'aiTeam' });

    useSessionStore.getState().setMobileFilesNavigationSurface();

    expect(useSessionStore.getState()).toMatchObject({ mobileContextOpen: false, mobileTab: 'files', sidebarTab: 'files', sidebarOpen: true, activeView: 'chat' });
  });
});

describe('mobile context workflow transitions', () => {
  it('can open a transient workflow context without pushing browser history', () => {
    const push = vi.spyOn(history, 'pushState');
    useSessionStore.setState({ isMobile: true, mobileTab: 'ai', sidebarOpen: false });

    useSessionStore.getState().openMobileContext(false);

    expect(push).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({ mobileContextOpen: true, mobileTab: 'edit', mobileTabBeforeContext: 'ai' });
    push.mockRestore();
  });

  it('finishes a workflow in chat without history.back and closes mobile chrome', () => {
    const back = vi.spyOn(history, 'back');
    useSessionStore.setState({ isMobile: true, mobileContextOpen: true, mobileTab: 'edit', mobileTabBeforeContext: 'files', sidebarOpen: true, activeView: 'projectFiles' });

    useSessionStore.getState().finishMobileContextInChat();

    expect(back).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({ mobileContextOpen: false, mobileTab: 'ai', mobileTabBeforeContext: 'ai', sidebarOpen: false, activeView: 'chat' });
    back.mockRestore();
  });
});

describe('updateSessionMeta', () => {
  it('skips no-op metadata updates so scalar selectors stay quiet', () => {
    const session: any = {
      id: 's1',
      name: 'Session 1',
      cwd: '/workspace',
      tags: [],
      favorite: false,
      totalCost: 0,
      totalTokens: 0,
      createdAt: '2026-05-31T00:00:00Z',
      updatedAt: '2026-05-31T00:00:00Z',
    };
    useSessionStore.setState({ sessions: [session] } as any);

    const before = useSessionStore.getState().sessions;
    useSessionStore.getState().updateSessionMeta('s1', { name: 'Session 1' } as any);
    expect(useSessionStore.getState().sessions).toBe(before);

    useSessionStore.getState().updateSessionMeta('s1', { name: 'Renamed' } as any);
    expect(useSessionStore.getState().sessions).not.toBe(before);
    expect(useSessionStore.getState().sessions[0].name).toBe('Renamed');
  });
});

describe('setSessionStreaming', () => {
  const baseSession = {
    id: 's1',
    name: 'Session 1',
    cwd: '/workspace',
    tags: [],
    favorite: false,
    totalCost: 0,
    totalTokens: 0,
    createdAt: '2026-05-31T00:00:00Z',
    updatedAt: '2026-05-31T00:00:00Z',
  } as any;

  it('does not create completion attention from a streaming edge', () => {
    localStorage.setItem('username', 'admin');
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'woomin1', lastUserUsername: 'admin' }],
      streamingSessions: new Set(['s1']),
      activeSessionId: null,
      activeView: 'chat',
    } as any);

    useSessionStore.getState().setSessionStreaming('s1', false);

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(false);
  });

  it('does not create attention while the completed session ChatPanel is actually foreground', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'admin' }],
      activeSessionId: 's1',
      visibleChatSessionId: 's1',
      activeView: 'chat',
    } as any);

    useSessionStore.getState().setTurnTerminal('s1', { rootTurnId: 'r1', outcome: 'completed', terminalAt: 1 });
    useSessionStore.getState().markSessionCompleted('s1');

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(false);
    expect(useSessionStore.getState().turnTerminalBySession.s1.read).toBe(true);
  });

  it('creates attention when activeSessionId matches but a system tab is foreground', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'admin' }],
      activeSessionId: 's1',
      visibleChatSessionId: null,
      activeView: 'chat',
    } as any);

    useSessionStore.getState().setTurnTerminal('s1', { rootTurnId: 'r1', outcome: 'completed', terminalAt: 1 });
    useSessionStore.getState().markSessionCompleted('s1');

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(true);
    expect(useSessionStore.getState().turnTerminalBySession.s1.read).toBe(false);
  });

  it('creates attention when the matching ChatPanel is hidden in another browser tab', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'admin' }],
      activeSessionId: 's1',
      visibleChatSessionId: 's1',
      activeView: 'chat',
    } as any);

    useSessionStore.getState().setTurnTerminal('s1', { rootTurnId: 'r1', outcome: 'completed', terminalAt: 1 });
    useSessionStore.getState().markSessionCompleted('s1');

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(true);
    expect(useSessionStore.getState().turnTerminalBySession.s1.read).toBe(false);
  });

  it('creates completion attention from an authoritative completed terminal', () => {
    localStorage.setItem('username', 'admin');
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'admin', lastUserUsername: null }],
      streamingSessions: new Set(['s1']),
      activeSessionId: null,
      activeView: 'chat',
    } as any);

    useSessionStore.getState().setTurnTerminal('s1', { rootTurnId: 'r1', outcome: 'completed', terminalAt: 1 });
    useSessionStore.getState().markSessionCompleted('s1');

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(true);
    expect(useSessionStore.getState().turnTerminalBySession.s1).toMatchObject({ rootTurnId: 'r1', outcome: 'completed', read: false });
  });

  it('creates attention for a completed background session even when cached speaker metadata is stale', () => {
    localStorage.setItem('username', 'admin');
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'woomin1', lastUserUsername: 'woomin1' }],
      streamingSessions: new Set(['s1']),
      activeSessionId: null,
      activeView: 'chat',
    } as any);

    useSessionStore.getState().setTurnTerminal('s1', { rootTurnId: 'r1', outcome: 'completed', terminalAt: 1 });
    useSessionStore.getState().markSessionCompleted('s1');

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(true);
  });

  it('ignores idle frames that do not transition from local streaming', () => {
    localStorage.setItem('username', 'admin');
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'admin', lastUserUsername: 'admin' }],
      streamingSessions: new Set(),
      activeSessionId: null,
      activeView: 'chat',
      unreadSessions: new Set(),
    } as any);

    useSessionStore.getState().setSessionStreaming('s1', false);

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(false);
  });

  it('persists latest unread/read attention state for hard refresh restore', () => {
    localStorage.setItem('username', 'admin');
    useSessionStore.setState({
      sessions: [{ ...baseSession, ownerUsername: 'admin', lastUserUsername: 'admin' }],
      streamingSessions: new Set(['s1']),
      activeSessionId: null,
      activeView: 'chat',
      unreadSessions: new Set(),
      recentlyReadSessionUntil: {},
    } as any);

    useSessionStore.getState().setTurnTerminal('s1', { rootTurnId: 'r1', outcome: 'completed', terminalAt: 1 });
    useSessionStore.getState().markSessionCompleted('s1');
    let saved = JSON.parse(localStorage.getItem('tower:latest-attention:v1:admin') || '{}');
    expect(saved.unreadSessionIds).toEqual(['s1']);

    useSessionStore.getState().markSessionRead('s1');
    saved = JSON.parse(localStorage.getItem('tower:latest-attention:v1:admin') || '{}');
    expect(saved.unreadSessionIds).toEqual([]);
    expect(saved.recentlyReadSessionUntil).toEqual({ s1: 1 });
  });

  it('hydrates latest attention state from server entries', async () => {
    localStorage.setItem('username', 'admin');
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        entries: [
          { sessionId: 's1', state: 'unread' },
          { sessionId: 's2', state: 'recently_read' },
          { sessionId: 's3', sessionUpdatedAt: '2026-07-03T00:00:00.000Z', state: 'dismissed' },
        ],
      }),
    })) as any;

    await useSessionStore.getState().hydrateLatestAttentionFromServer();

    expect(useSessionStore.getState().unreadSessions.has('s1')).toBe(true);
    expect(useSessionStore.getState().recentlyReadSessionUntil).toEqual({ s2: 1 });
    expect(JSON.parse(localStorage.getItem('tower:latest-dismissed-keys:v1:admin') || '[]'))
      .toEqual(['s3:2026-07-03T00:00:00.000Z']);
  });

  it('does not erase a live unread completion when a stale hydration finishes later', async () => {
    localStorage.setItem('username', 'admin');
    let resolveFetch!: (value: unknown) => void;
    global.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })) as any;

    const hydration = useSessionStore.getState().hydrateLatestAttentionFromServer();
    useSessionStore.setState({ unreadSessions: new Set(['live-session']) } as any);
    resolveFetch({
      ok: true,
      json: async () => ({ entries: [] }),
    });
    await hydration;

    expect(useSessionStore.getState().unreadSessions.has('live-session')).toBe(true);
  });
});

describe('setLastTurnText — multi-turn msgId accumulation', () => {
  it('accumulates text from different msgIds in the same turn', () => {
    const store = useSessionStore.getState();

    // First assistant message in the turn
    store.setLastTurnText('s1', 'I will analyze the code.', false, 'msg-1');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('I will analyze the code.');

    // Second assistant message (after tool use) with a different msgId
    store.setLastTurnText('s1', 'Here are the results.', false, 'msg-2');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('I will analyze the code.\n\nHere are the results.');

    // Third assistant message
    store.setLastTurnText('s1', 'All done!', false, 'msg-3');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('I will analyze the code.\n\nHere are the results.\n\nAll done!');
  });

  it('updates text for the same msgId without duplicating (streaming)', () => {
    const store = useSessionStore.getState();

    // Streaming: same msgId with growing text
    store.setLastTurnText('s1', 'Hel', false, 'msg-1');
    store.setLastTurnText('s1', 'Hello world', false, 'msg-1');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Hello world');

    // Add a second msgId
    store.setLastTurnText('s1', 'Second part', false, 'msg-2');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Hello world\n\nSecond part');
  });

  it('resets msgTexts when previous turn was finalized (new turn)', () => {
    const store = useSessionStore.getState();

    // Turn 1: two assistant messages, then finalized
    store.setLastTurnText('s1', 'Turn 1 msg A', false, 'msg-1');
    store.setLastTurnText('s1', 'Turn 1 msg B', false, 'msg-2');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Turn 1 msg A\n\nTurn 1 msg B');

    // Finalize the turn (turn_done)
    const compositeText = useSessionStore.getState().lastTurnTextBySession['s1']!.text;
    store.setLastTurnText('s1', compositeText, true);

    // New turn begins — should NOT include old msgTexts
    store.setLastTurnText('s1', 'Turn 2 msg A', false, 'msg-3');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Turn 2 msg A');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.finalized)
      .toBe(false);
  });

  it('legacy path (no msgId) replaces text entirely', () => {
    const store = useSessionStore.getState();

    store.setLastTurnText('s1', 'Initial text');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Initial text');

    store.setLastTurnText('s1', 'Replaced text');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Replaced text');
  });

  it('skips no-op updates for same msgId + text', () => {
    const store = useSessionStore.getState();

    store.setLastTurnText('s1', 'Same text', false, 'msg-1');
    const entry1 = useSessionStore.getState().lastTurnTextBySession['s1'];

    // Same call — should be a no-op (returns same state reference)
    store.setLastTurnText('s1', 'Same text', false, 'msg-1');
    const entry2 = useSessionStore.getState().lastTurnTextBySession['s1'];

    // updatedAt should be the same since it was a no-op
    expect(entry1?.updatedAt).toBe(entry2?.updatedAt);
  });

  it('handles independent sessions without cross-contamination', () => {
    const store = useSessionStore.getState();

    store.setLastTurnText('s1', 'Session 1 msg', false, 'msg-1');
    store.setLastTurnText('s2', 'Session 2 msg', false, 'msg-2');

    expect(useSessionStore.getState().lastTurnTextBySession['s1']?.text)
      .toBe('Session 1 msg');
    expect(useSessionStore.getState().lastTurnTextBySession['s2']?.text)
      .toBe('Session 2 msg');
  });

  it('clearLastTurnText removes session entry', () => {
    const store = useSessionStore.getState();

    store.setLastTurnText('s1', 'Some text', false, 'msg-1');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']).toBeDefined();

    store.clearLastTurnText('s1');
    expect(useSessionStore.getState().lastTurnTextBySession['s1']).toBeUndefined();
  });
});
