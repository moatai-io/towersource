import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';

// ── Mocks (must be before dynamic import) ──────────────────────────

const mockExecuteQuery = vi.fn();
const mockAbortSession = vi.fn(() => true);
const mockCleanupSession = vi.fn();
const mockGetClaudeSessionId = vi.fn();
const mockGetActiveSessionCount = vi.fn(() => 0);
const mockGetSDKSession = vi.fn((): { isRunning: boolean } | undefined => undefined);
const mockGetTasks = vi.fn(() => []);
const mockAppendProcessEvent = vi.fn(async () => ({ id: 'pe-1' }));
const mockPublishWsSyncEvent = vi.fn();
const mockInitWsSync = vi.fn(async (_origin: string, handlers: any) => {
  capturedWsSyncHandlers = handlers;
});
let capturedWsSyncHandlers: any = null;

vi.mock('../services/ai/claude-sdk.js', () => ({
  executeQuery: mockExecuteQuery,
  abortSession: mockAbortSession,
  cleanupSession: mockCleanupSession,
  getClaudeSessionId: mockGetClaudeSessionId,
  getActiveSessionCount: mockGetActiveSessionCount,
  getSession: mockGetSDKSession,
  getRunningSessionIds: vi.fn(() => []),
  backupSessionFile: vi.fn(),
}));

const mockSaveMessage = vi.fn();
vi.mock('../services/message-store.js', () => ({
  saveMessage: mockSaveMessage,
  updateMessageContent: vi.fn(),
  attachToolResultInDb: vi.fn(),
  updateMessageMetrics: vi.fn(),
  markCompactBoundary: vi.fn(),
  getMessages: vi.fn(async () => []),
  touchMessages: vi.fn(),
  deleteMessage: vi.fn(),
  findRecoverableAgentTurnForSession: vi.fn(async () => undefined),
  markAgentTurnCheckpoint: vi.fn(async () => undefined),
}));

vi.mock('../services/session/session-manager.js', () => ({
  claimEngineSessionId: vi.fn(async () => undefined),
  getEngineSessionId: vi.fn((session: any) => {
    if (!session) return undefined;
    return session.engine === 'pi' ? session.piSessionFile : session.claudeSessionId;
  }),
  getSession: vi.fn(() => null),
  updateSession: vi.fn(),
}));

vi.mock('../services/workspace/file-system.js', () => ({
  getFileTree: vi.fn(() => []),
  readFile: vi.fn(() => ({ content: '', language: 'text' })),
  writeFile: vi.fn(),
  setupFileWatcher: vi.fn(),
}));

vi.mock('../services/git/git-manager.js', () => ({
  autoCommit: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/auth/auth.js', () => ({
  verifyWsToken: vi.fn(() => null),
  getUserAllowedPath: vi.fn(() => null),
}));

vi.mock('../db/pg-repo.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => undefined),
  execute: vi.fn(async () => ({ changes: 0 })),
}));

vi.mock('../services/task/task-runner.js', () => ({
  spawnTask: vi.fn(),
  abortTask: vi.fn(),
}));

vi.mock('../services/damage-control.js', () => ({
  buildDamageControl: vi.fn(() => () => true),
  buildPathEnforcement: vi.fn(() => null),
  // Added 2026-04-29 — must mirror real exports so project-access.ts can import.
  // The mocked guard always allows; secret protection is exercised in damage-control.test.ts.
  buildSecretGuard: vi.fn(() => () => ({ allowed: true })),
}));

vi.mock('../services/system-prompt.js', () => ({
  buildSystemPrompt: vi.fn(() => 'test system prompt'),
}));

vi.mock('../services/task/task-manager.js', () => ({
  getTasks: mockGetTasks,
}));

vi.mock('../services/process/process-map-manager.js', () => ({
  appendProcessEvent: mockAppendProcessEvent,
}));

vi.mock('../services/skill/skill-registry.js', async () => {
  const actual = await vi.importActual<any>('../services/skill/skill-registry.js');
  return {
    ...actual,
    getCommandsForUser: vi.fn(async (...args: any[]) => {
      const commands = await actual.getCommandsForUser(...args);
      return [
        ...commands,
        actual.__testSkillCommandEntry?.() || {
          id: 'meeting-prep',
          kind: 'skill',
          canonical: '/meeting-prep',
          name: '/meeting-prep',
          aliases: ['/meeting-prep', '/회의준비'],
          displayName: '회의 준비',
          description: '회의 전 준비를 돕는다',
          argumentHint: '[회의명]',
          fullContent: '---\ndescription: 회의 전 준비\n---\n# Meeting Prep\nFollow the checklist.',
          source: 'skills',
          scope: 'project',
          risk: 'medium',
          dispatch: { type: 'skill', target: 'meeting-prep' },
        },
      ];
    }),
  };
});

vi.mock('../config.js', () => ({
  config: {
    authEnabled: false,
    workspaceRoot: '/tmp/test',
    defaultCwd: '/tmp/test',
    dataDir: '/tmp/test-data',
    maxConcurrentSessions: 5,
    serverEpoch: 'test-epoch',
    gitAutoCommit: false,
    claudeEnabled: true,
    piEnabled: true,
    sandbox: { enabled: false },
  },
  getPermissionMode: vi.fn(() => 'default'),
}));

vi.mock('../db/pg.js', () => ({
  isPgEnabled: vi.fn(() => true),
}));

vi.mock('../services/ws-sync.js', () => ({
  initWsSync: mockInitWsSync,
  publishWsSyncEvent: mockPublishWsSyncEvent,
}));

// ── Helpers ─────────────────────────────────────────────────────────

let server: Server;
let serverPort: number;
let setupWebSocket: (s: Server) => any;

function createWsClient(): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

function waitForMessage(
  messages: any[],
  type: string,
  timeout = 2000,
): Promise<any> {
  const found = messages.find((m) => m.type === type);
  if (found) return Promise.resolve(found);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeout);
    const interval = setInterval(() => {
      const msg = messages.find((m) => m.type === type);
      if (msg) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(msg);
      }
    }, 20);
  });
}

function waitForMessages(
  messages: any[],
  type: string,
  count: number,
  timeout = 2000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${count}x "${type}"`)), timeout);
    const interval = setInterval(() => {
      const found = messages.filter((m) => m.type === type);
      if (found.length >= count) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(found);
      }
    }, 20);
  });
}

function sendJson(ws: WebSocket, data: any) {
  ws.send(JSON.stringify(data));
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}


// ── Setup ───────────────────────────────────────────────────────────

beforeAll(async () => {
  const mod = await import('./ws-handler.js');
  setupWebSocket = mod.setupWebSocket;

  server = createServer();
  setupWebSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as any).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('ws-handler integration', () => {
  describe('connection', () => {
    it('sends connected message with clientId on connection', async () => {
      const { ws, messages } = await createWsClient();
      const msg = await waitForMessage(messages, 'connected');

      expect(msg.type).toBe('connected');
      expect(msg.clientId).toBeTruthy();
      expect(msg.serverEpoch).toBe('test-epoch');

      ws.close();
    });
  });

  describe('set_active_session', () => {
    it('keeps the connected client resume state engine-neutral while accepting the legacy wire alias', () => {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf-8');

      expect(src).toContain('engineSessionId?: string; // Active engine-native resume ID');
      expect(src).toContain('client.engineSessionId = data.engineSessionId || data.claudeSessionId || undefined;');
      expect(src).not.toContain('client.claudeSessionId');
    });

    it('sends ack and cleans up idle session on switch (no abort of running sessions)', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      // Set first session
      sendJson(ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(messages, 'set_active_session_ack');

      // Switch to second session → old idle session should be cleaned up but NOT aborted
      mockGetSDKSession.mockReturnValueOnce({ isRunning: false });
      sendJson(ws, { type: 'set_active_session', sessionId: 's2' });
      const ack = await waitForMessages(messages, 'set_active_session_ack', 2);

      expect(ack[1].sessionId).toBe('s2');
      expect(mockAbortSession).not.toHaveBeenCalled();

      ws.close();
    });

    it('does not abort when re-setting the same session', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      sendJson(ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockAbortSession.mockClear();

      sendJson(ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessages(messages, 'set_active_session_ack', 2);

      expect(mockAbortSession).not.toHaveBeenCalled();

      ws.close();
    });
  });

  describe('slash command dispatch', () => {
    it('handles /task list without starting an engine run', async () => {
      mockGetTasks.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'slash-task-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      sendJson(ws, { type: 'chat', message: '/task list overdue', sessionId: 'slash-task-s1' });

      const taskList = await waitForMessage(messages, 'task_list');
      const executed = await waitForMessage(messages, 'command_executed');
      expect(taskList.tasks).toHaveLength(2);
      expect(executed).toMatchObject({
        sessionId: 'slash-task-s1',
        commandId: 'native:task-list',
        message: '태스크 목록을 갱신했습니다. (2개)',
      });
      expect(mockExecuteQuery).not.toHaveBeenCalled();
      ws.close();
    });

    it('handles /skills as a UI action without starting an engine run', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'slash-skills-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      sendJson(ws, { type: 'chat', message: '/스킬', sessionId: 'slash-skills-s1' });

      const executed = await waitForMessage(messages, 'command_executed');
      expect(executed).toMatchObject({
        sessionId: 'slash-skills-s1',
        commandId: 'native:skills',
        uiAction: { type: 'open_panel', panel: 'skills' },
      });
      expect(mockExecuteQuery).not.toHaveBeenCalled();
      ws.close();
    });

    it('opens Agents panel for /agent without task instead of starting an engine run', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'slash-agent-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      sendJson(ws, { type: 'chat', message: '/agent', sessionId: 'slash-agent-s1' });

      const executed = await waitForMessage(messages, 'command_executed');
      expect(executed).toMatchObject({
        sessionId: 'slash-agent-s1',
        commandId: 'workflow:agent',
        uiAction: { type: 'open_panel', panel: 'agents' },
      });
      expect(mockExecuteQuery).not.toHaveBeenCalled();
      ws.close();
    });

    it('injects SKILL.md content and notifies the user for explicit slash skill commands', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'slash-skill-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'skill-a1', message: { content: [{ type: 'text', text: 'prepared' }] } };
        yield { type: 'turn_done', assistantMsgIds: ['skill-a1'] };
        yield { type: 'engine_done', outcome: 'completed', assistantMessageId: 'skill-a1' };
      });
      sendJson(ws, { type: 'chat', message: '/회의준비 내일 고객 미팅', sessionId: 'slash-skill-s1' });

      const invoked = await waitForMessage(messages, 'skill_invoked');
      expect(invoked).toMatchObject({
        sessionId: 'slash-skill-s1',
        skillName: 'meeting-prep',
        displayName: '회의 준비',
        trigger: 'slash',
        matchedAlias: '/회의준비',
        explicit: true,
        context: expect.objectContaining({
          kind: 'active_skill',
          skillName: 'meeting-prep',
          readState: 'loaded',
        }),
      });
      const savedUser = mockSaveMessage.mock.calls.find((call) => call[1]?.role === 'user')?.[1];
      expect(savedUser?.metadata?.skillInvocation).toMatchObject({
        skillName: 'meeting-prep',
        matchedAlias: '/회의준비',
      });
      expect(mockAppendProcessEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'slash-skill-s1',
        sourceType: 'skill_invocation',
        sourceId: 'slash:meeting-prep',
        eventType: 'step_started',
        rawLabel: 'Skill started: 회의 준비',
        rawPayload: expect.objectContaining({
          skillName: 'meeting-prep',
          matchedAlias: '/회의준비',
          phase: 'started',
          activeSkillContext: expect.objectContaining({ readState: 'loaded', skillName: 'meeting-prep' }),
        }),
      }));
      const assistantTowerMsg = await waitForMessage(messages, 'tower_message');
      await waitForMessages(messages, 'tower_message', 2);
      // The mocked assistant is not persisted, so the unified terminal decision
      // correctly withholds durable completion side effects.
      expect(mockAppendProcessEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'slash-skill-s1',
        sourceType: 'skill_invocation',
        sourceId: 'slash:meeting-prep',
        eventType: 'step_completed',
      }));
      expect(assistantTowerMsg.message?.metadata?.skillInvocation).toMatchObject({
        skillName: 'meeting-prep',
        matchedAlias: '/회의준비',
      });
      const savedAssistant = mockSaveMessage.mock.calls.find((call) => call[1]?.role === 'assistant')?.[1];
      expect(savedAssistant?.metadata?.skillInvocation).toMatchObject({
        skillName: 'meeting-prep',
        matchedAlias: '/회의준비',
      });
      const prompt = mockExecuteQuery.mock.calls[0]?.[1];
      expect(prompt).toContain('<active_skill name="meeting-prep" read_state="loaded">');
      expect(prompt).toContain('# Meeting Prep');
      expect(prompt).toContain('Original command: /회의준비 내일 고객 미팅');
      expect(prompt).toContain('Arguments: 내일 고객 미팅');
      ws.close();
    });

    it('tracks natural-language skill mentions as natural-language SkillInvocation', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'nl-skill-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'nl-a1', message: { content: [{ type: 'text', text: 'prepared' }] } };
      });
      sendJson(ws, { type: 'chat', message: '회의준비 스킬로 내일 고객 미팅 준비해줘', sessionId: 'nl-skill-s1' });

      const invoked = await waitForMessage(messages, 'skill_invoked');
      expect(invoked).toMatchObject({
        sessionId: 'nl-skill-s1',
        skillName: 'meeting-prep',
        trigger: 'natural-language',
        explicit: false,
      });
      const savedUser = mockSaveMessage.mock.calls.find((call) => call[0] === 'nl-skill-s1' && call[1]?.role === 'user')?.[1];
      expect(savedUser?.metadata?.skillInvocation).toMatchObject({
        skillName: 'meeting-prep',
        trigger: 'natural-language',
        explicit: false,
      });
      ws.close();
    });

    it('tracks command picker skill selections as picker-triggered SkillInvocation', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'picker-skill-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'picker-a1', message: { content: [{ type: 'text', text: 'prepared' }] } };
      });
      sendJson(ws, { type: 'chat', message: '/회의준비 내일 고객 미팅', commandTrigger: 'picker', sessionId: 'picker-skill-s1' });

      const invoked = await waitForMessage(messages, 'skill_invoked');
      expect(invoked).toMatchObject({
        sessionId: 'picker-skill-s1',
        skillName: 'meeting-prep',
        trigger: 'picker',
        matchedAlias: '/회의준비',
        explicit: true,
      });
      const savedUser = mockSaveMessage.mock.calls.find((call) => call[0] === 'picker-skill-s1' && call[1]?.role === 'user')?.[1];
      expect(savedUser?.metadata?.skillInvocation).toMatchObject({
        skillName: 'meeting-prep',
        trigger: 'picker',
      });
      ws.close();
    });
  });

  describe('chat + routing', () => {
    it('routes busy Pi chat as steering instead of end-of-turn queue when supported', () => {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf-8');
      expect(src).toMatch(/engineName === 'pi'/);
      // steer() now carries msgId + username so the engine can emit
      // steer_delivered (issue #15/#17) — see ws-handler steer branch.
      expect(src).toMatch(/\.steer\(sessionId, data\.message, steeredMsgId, client\.username \|\| null\)/);
      expect(src).toMatch(/user_message_steered/);
    });

    it('does NOT route tower_message to clients on a different session', async () => {
      // Client A on session s1
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client B on session s2
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');
      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 's2' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      // Mock executeQuery to yield one message for s1
      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } };
      });

      sendJson(clientA.ws, { type: 'chat', message: 'hello', sessionId: 's1' });

      // Client A should get tower_message
      await waitForMessage(clientA.messages, 'tower_message');

      // Wait a bit then check client B did NOT get tower_message (different session)
      await delay(200);
      const bTowerMsgs = clientB.messages.filter((m) => m.type === 'tower_message');
      expect(bTowerMsgs.length).toBe(0);

      // Regression guard: legacy sdk_message duplicate path must not fire.
      const aSdkMsgs = clientA.messages.filter((m) => m.type === 'sdk_message');
      expect(aSdkMsgs.length).toBe(0);

      clientA.ws.close();
      clientB.ws.close();
    });

    it('drops duplicate chat frames with the same message id before saving or dispatching twice', async () => {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf-8');
      expect(src).toMatch(/releaseUserInputDedupe/);
      expect(src).toMatch(/immediate edit-and-resend/);

      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'dedupe-id-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        await new Promise((r) => setTimeout(r, 100));
        yield { type: 'assistant', uuid: 'a-dedupe-id', message: { content: [{ type: 'text', text: 'ok' }] } };
      });

      sendJson(ws, { type: 'chat', message: 'same compact-race input by id', sessionId: 'dedupe-id-s1', messageId: 'dedupe-same-id' });
      sendJson(ws, { type: 'chat', message: 'same compact-race input by id', sessionId: 'dedupe-id-s1', messageId: 'dedupe-same-id' });

      const dropped = await waitForMessage(messages, 'duplicate_user_message_dropped');
      expect(dropped.sessionId).toBe('dedupe-id-s1');
      expect(dropped.reason).toBe('messageId');

      await waitForMessage(messages, 'sdk_done', 3000);
      const savedUsers = mockSaveMessage.mock.calls.filter(([, msg]) => msg?.role === 'user' && msg?.content?.[0]?.text === 'same compact-race input by id');
      expect(savedUsers).toHaveLength(1);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);

      ws.close();
    });

    it('collapses an immediate same-text burst even when duplicate frames have distinct message ids', async () => {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf-8');
      expect(src).toMatch(/RECENT_INPUT_TEXT_BURST_MS = 1_500/);
      expect(src).toMatch(/immediateDuplicateBurst/);

      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'dedupe-text-burst-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        await new Promise((r) => setTimeout(r, 100));
        yield { type: 'assistant', uuid: 'a-burst', message: { content: [{ type: 'text', text: 'ok' }] } };
      });

      for (let i = 1; i <= 4; i++) {
        sendJson(ws, {
          type: 'chat',
          message: 'continue',
          sessionId: 'dedupe-text-burst-s1',
          messageId: `dedupe-burst-m${i}`,
        });
      }

      const dropped = await waitForMessage(messages, 'duplicate_user_message_dropped');
      expect(dropped.sessionId).toBe('dedupe-text-burst-s1');
      expect(dropped.reason).toBe('text');

      await waitForMessage(messages, 'sdk_done', 3000);
      await delay(150);
      const savedUsers = mockSaveMessage.mock.calls.filter(([, msg]) => msg?.role === 'user' && msg?.content?.[0]?.text === 'continue');
      expect(savedUsers).toHaveLength(1);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);

      ws.close();
    });

    it('allows an intentional same-text retry after the duplicate burst window', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'dedupe-text-retry-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementation(async function* () {
        yield { type: 'assistant', uuid: `a-retry-${mockExecuteQuery.mock.calls.length}`, message: { content: [{ type: 'text', text: 'ok' }] } };
      });

      sendJson(ws, {
        type: 'chat',
        message: 'continue after waiting',
        sessionId: 'dedupe-text-retry-s1',
        messageId: 'dedupe-retry-m1',
      });
      await waitForMessage(messages, 'sdk_done', 3000);
      await delay(1_600);
      sendJson(ws, {
        type: 'chat',
        message: 'continue after waiting',
        sessionId: 'dedupe-text-retry-s1',
        messageId: 'dedupe-retry-m2',
      });
      await waitForMessages(messages, 'sdk_done', 2, 3000);

      const savedUsers = mockSaveMessage.mock.calls.filter(([, msg]) => msg?.role === 'user' && msg?.content?.[0]?.text === 'continue after waiting');
      expect(savedUsers).toHaveLength(2);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);

      ws.close();
    });

    it('broadcasts tower_message to ALL clients viewing the same session', async () => {
      // Client A on session s1
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client B also on session s1 (second tab)
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');
      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      // Mock executeQuery to yield one message
      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } };
      });

      sendJson(clientA.ws, { type: 'chat', message: 'hello', sessionId: 's1' });

      // BOTH clients should get tower_message (new primary path)
      await waitForMessage(clientA.messages, 'tower_message');
      await waitForMessage(clientB.messages, 'tower_message');

      // Both should also get sdk_done (legacy terminal frame — still emitted)
      await waitForMessage(clientA.messages, 'sdk_done');
      await waitForMessage(clientB.messages, 'sdk_done');

      // Regression guard: legacy sdk_message must not fire for assistant content.
      expect(clientA.messages.filter((m) => m.type === 'sdk_message').length).toBe(0);
      expect(clientB.messages.filter((m) => m.type === 'sdk_message').length).toBe(0);

      clientA.ws.close();
      clientB.ws.close();
    });
  });

  describe('session switch mid-stream', () => {
    it('streaming continues in background when client switches sessions', async () => {
      // Client A starts chat on s1, then switches to s2
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client B stays on s1 to verify messages keep arriving
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');
      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      // Mock a slow generator that yields multiple messages
      let yielded = 0;
      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'first' }] } };
        yielded++;
        await new Promise((r) => setTimeout(r, 100));
        yield { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'second' }] } };
        yielded++;
        await new Promise((r) => setTimeout(r, 100));
        yield { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'third' }] } };
        yielded++;
      });

      sendJson(clientA.ws, { type: 'chat', message: 'start long query', sessionId: 's1' });

      // Wait for first tower_message on client A
      await waitForMessage(clientA.messages, 'tower_message');

      // Client A switches session mid-stream — streaming should NOT be aborted
      mockGetSDKSession.mockReturnValueOnce({ isRunning: false });
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 's2' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client B (still on s1) should receive all 3 messages + sdk_done
      await waitForMessages(clientB.messages, 'tower_message', 3, 3000);
      await waitForMessage(clientB.messages, 'sdk_done');

      // Generator should have completed all yields
      expect(yielded).toBe(3);

      // abortSession should NOT have been called
      expect(mockAbortSession).not.toHaveBeenCalled();

      clientA.ws.close();
      clientB.ws.close();
    });

    it('set_active_session_ack includes isStreaming flag', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      // Switch to a session with active SDK
      mockGetSDKSession.mockReturnValueOnce({ isRunning: true });
      sendJson(ws, { type: 'set_active_session', sessionId: 's-streaming' });
      const ack = await waitForMessage(messages, 'set_active_session_ack');

      expect(ack.sessionId).toBe('s-streaming');
      expect(ack.isStreaming).toBe(true);

      ws.close();
    });

    it('set_active_session_ack does not revive stale remote streaming cache without a fresh snapshot', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      capturedWsSyncHandlers?.all({ type: 'session_status', sessionId: 'stale-remote', status: 'streaming' });

      sendJson(ws, { type: 'set_active_session', sessionId: 'stale-remote' });
      const ack = await waitForMessage(messages, 'set_active_session_ack');

      expect(ack.sessionId).toBe('stale-remote');
      expect(ack.isStreaming).toBe(false);
      expect(mockPublishWsSyncEvent).toHaveBeenCalledWith(
        'test-epoch',
        expect.objectContaining({
          scope: 'session',
          sessionId: 'stale-remote',
          data: expect.objectContaining({ type: 'session_snapshot_request' }),
        }),
      );

      capturedWsSyncHandlers?.all({ type: 'session_status', sessionId: 'stale-remote', status: 'idle' });
      ws.close();
    });

    it('session_snapshot_response false clears stale remote streaming cache', async () => {
      capturedWsSyncHandlers?.all({ type: 'session_status', sessionId: 'remote-cleared', status: 'streaming' });
      capturedWsSyncHandlers?.session('remote-cleared', {
        type: 'session_snapshot_response',
        requestId: 'no-waiter',
        isStreaming: false,
        pendingQuestion: null,
      });

      const { ws, messages } = await createWsClient();
      const connected = await waitForMessage(messages, 'connected');

      expect(connected.streamingSessions || []).not.toContain('remote-cleared');
      ws.close();
    });

    it('set_active_session_ack includes remote pending question from snapshot', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      mockPublishWsSyncEvent.mockImplementation((_origin: string, envelope: any) => {
        if (envelope.scope === 'session' && envelope.sessionId === 'remote-active' && envelope.data?.type === 'session_snapshot_request') {
          queueMicrotask(() => {
            capturedWsSyncHandlers?.session('remote-active', {
              type: 'session_snapshot_response',
              requestId: envelope.data.requestId,
              isStreaming: true,
              pendingQuestion: {
                questionId: 'remote-q1',
                questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
              },
            });
          });
        }
      });

      sendJson(ws, { type: 'set_active_session', sessionId: 'remote-active' });
      const ack = await waitForMessage(messages, 'set_active_session_ack');

      expect(ack.sessionId).toBe('remote-active');
      expect(ack.isStreaming).toBe(true);
      expect(ack.pendingQuestion?.questionId).toBe('remote-q1');

      ws.close();
    });
  });

  describe('reconnect', () => {
    it('new client receives messages after reconnect', async () => {
      // Client A sets session s1
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client A disconnects
      clientA.ws.close();
      await delay(100);

      // Client B reconnects to s1
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');

      mockGetSDKSession.mockReturnValueOnce({ isRunning: false });
      sendJson(clientB.ws, { type: 'reconnect', sessionId: 's1' });
      const reconnectResult = await waitForMessage(clientB.messages, 'reconnect_result');
      expect(reconnectResult.sessionId).toBe('s1');

      // Now send chat on s1 — client B should receive it
      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'r1', message: { content: [{ type: 'text', text: 'reconnected' }] } };
      });

      sendJson(clientB.ws, { type: 'chat', message: 'after reconnect', sessionId: 's1' });
      await waitForMessage(clientB.messages, 'tower_message');

      const towerMsg = clientB.messages.find((m) => m.type === 'tower_message');
      expect(towerMsg.sessionId).toBe('s1');

      clientB.ws.close();
    });

    it('uses remote snapshot to restore streaming status on reconnect', async () => {
      const client = await createWsClient();
      await waitForMessage(client.messages, 'connected');

      mockPublishWsSyncEvent.mockImplementation((_origin: string, envelope: any) => {
        if (envelope.scope === 'session' && envelope.sessionId === 'remote-s1' && envelope.data?.type === 'session_snapshot_request') {
          queueMicrotask(() => {
            capturedWsSyncHandlers?.session('remote-s1', {
              type: 'session_snapshot_response',
              requestId: envelope.data.requestId,
              isStreaming: true,
              pendingQuestion: {
                questionId: 'q-remote',
                questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
              },
            });
          });
        }
      });

      sendJson(client.ws, { type: 'reconnect', sessionId: 'remote-s1' });
      const reconnectResult = await waitForMessage(client.messages, 'reconnect_result');

      expect(reconnectResult).toMatchObject({
        type: 'reconnect_result',
        sessionId: 'remote-s1',
        status: 'streaming',
      });
      expect(reconnectResult.pendingQuestion?.questionId).toBe('q-remote');
      expect(mockPublishWsSyncEvent).toHaveBeenCalled();

      client.ws.close();
    });
  });

  describe('abort', () => {
    it('returns abort_result and bumps epoch', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      sendJson(ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockAbortSession.mockReturnValueOnce(true);
      sendJson(ws, { type: 'abort', sessionId: 's1' });

      const result = await waitForMessage(messages, 'abort_result');
      expect(result.aborted).toBe(true);
      expect(result.sessionId).toBe('s1');
      expect(mockAbortSession).toHaveBeenCalledWith('s1');

      ws.close();
    });

    it('publishes abort sync so remote owner can stop the session', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      sendJson(ws, { type: 'set_active_session', sessionId: 'remote-abort-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      sendJson(ws, { type: 'abort', sessionId: 'remote-abort-s1' });
      await waitForMessage(messages, 'abort_result');

      expect(mockPublishWsSyncEvent).toHaveBeenCalledWith('test-epoch', expect.objectContaining({
        scope: 'session',
        sessionId: 'remote-abort-s1',
        data: expect.objectContaining({ type: 'abort_session_sync' }),
      }));

      ws.close();
    });
  });

  describe('answer_question sync', () => {
    it('publishes answer sync when pending question lives on another instance', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      sendJson(ws, { type: 'set_active_session', sessionId: 'remote-question-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      sendJson(ws, {
        type: 'answer_question',
        sessionId: 'remote-question-s1',
        questionId: 'remote-q1',
        answer: 'Yes',
      });

      await delay(50);

      expect(mockPublishWsSyncEvent).toHaveBeenCalledWith('test-epoch', expect.objectContaining({
        scope: 'session',
        sessionId: 'remote-question-s1',
        data: expect.objectContaining({
          type: 'answer_question_sync',
          questionId: 'remote-q1',
          answer: 'Yes',
        }),
      }));

      ws.close();
    });
  });

  describe('ws close', () => {
    it('cleans up and allows new client to take over session', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      sendJson(ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(messages, 'set_active_session_ack');

      // SDK is idle
      mockGetSDKSession.mockReturnValueOnce({ isRunning: false });

      ws.close();
      await delay(100);

      // Verify: a new client sending to s1 should work
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');

      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 's1' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'b1', message: { content: [{ type: 'text', text: 'hi' }] } };
      });

      sendJson(clientB.ws, { type: 'chat', message: 'test', sessionId: 's1' });
      const msg = await waitForMessage(clientB.messages, 'tower_message');
      expect(msg.sessionId).toBe('s1');

      clientB.ws.close();
    });
  });

  // ── Message routing correctness ────────────────────────────────
  // Regression tests: messages must be saved under the correct sessionId.
  // Past bug: frontend sent sessionId A, but messages were stored under B
  // due to session creation race conditions.

  describe('cross-device user message sync', () => {
    it('broadcasts user_message to other clients viewing the same session (excludes sender)', async () => {
      // Client A on session s1
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 'sync-s1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client B also on session s1 (another device/tab)
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');
      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 'sync-s1' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      // Client C on different session s2 (should NOT receive)
      const clientC = await createWsClient();
      await waitForMessage(clientC.messages, 'connected');
      sendJson(clientC.ws, { type: 'set_active_session', sessionId: 'sync-s2' });
      await waitForMessage(clientC.messages, 'set_active_session_ack');

      // Client A sends a chat message
      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'reply' }] } };
      });
      sendJson(clientA.ws, { type: 'chat', message: 'hello from mobile', sessionId: 'sync-s1' });

      // Client B should receive user_message (cross-device sync)
      const userMsg = await waitForMessage(clientB.messages, 'user_message');
      expect(userMsg.sessionId).toBe('sync-s1');
      expect(userMsg.message.role).toBe('user');
      expect(userMsg.message.content[0].text).toBe('hello from mobile');

      // Client A (sender) should NOT receive user_message
      await delay(200);
      const senderUserMsgs = clientA.messages.filter((m) => m.type === 'user_message');
      expect(senderUserMsgs.length).toBe(0);

      // Client C (different session) should NOT receive user_message
      const otherUserMsgs = clientC.messages.filter((m) => m.type === 'user_message');
      expect(otherUserMsgs.length).toBe(0);

      clientA.ws.close();
      clientB.ws.close();
      clientC.ws.close();
    });

    it('user_message includes all necessary fields for frontend rendering', async () => {
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 'fields-s1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');
      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 'fields-s1' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'f1', message: { content: [{ type: 'text', text: 'ok' }] } };
      });

      sendJson(clientA.ws, { type: 'chat', message: 'test fields', sessionId: 'fields-s1', messageId: 'custom-msg-id' });

      const userMsg = await waitForMessage(clientB.messages, 'user_message');
      expect(userMsg.message).toMatchObject({
        id: 'custom-msg-id',
        role: 'user',
        content: [{ type: 'text', text: 'test fields' }],
      });
      expect(userMsg.message.createdAt).toBeTruthy();

      clientA.ws.close();
      clientB.ws.close();
    });
  });

  describe('message routing — sessionId consistency', () => {
    it('saves user message under the sessionId from chat request', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'route-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'r1', message: { content: [{ type: 'text', text: 'ok' }] } };
      });

      sendJson(ws, { type: 'chat', message: 'test routing', sessionId: 'route-s1' });
      await waitForMessage(messages, 'sdk_done');

      // saveMessage should have been called with 'route-s1' for the user message
      const userSave = mockSaveMessage.mock.calls.find(
        (args: any[]) => args[0] === 'route-s1' && args[1]?.role === 'user'
      );
      expect(userSave).toBeTruthy();
      expect(userSave![1].content[0].text).toBe('test routing');

      ws.close();
    });

    it('sdk_done includes the same sessionId as the chat request', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');
      sendJson(ws, { type: 'set_active_session', sessionId: 'done-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'd1', message: { content: [{ type: 'text', text: 'hi' }] } };
      });

      sendJson(ws, { type: 'chat', message: 'check done', sessionId: 'done-s1' });
      const done = await waitForMessage(messages, 'sdk_done');

      // sdk_done must carry the original sessionId so frontend auto-name uses it
      expect(done.sessionId).toBe('done-s1');

      ws.close();
    });

    it('rejects chat when no sessionId is provided', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      // Send chat without sessionId and without prior set_active_session
      sendJson(ws, { type: 'chat', message: 'orphan message' });
      const err = await waitForMessage(messages, 'error');

      expect(err.errorCode).toBe('NO_SESSION_ID');

      ws.close();
    });

    it('uses client.sessionId as fallback when chat request omits sessionId', async () => {
      const { ws, messages } = await createWsClient();
      await waitForMessage(messages, 'connected');

      // First set active session to establish client.sessionId
      sendJson(ws, { type: 'set_active_session', sessionId: 'fallback-s1' });
      await waitForMessage(messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'f1', message: { content: [{ type: 'text', text: 'fallback' }] } };
      });

      // Send chat WITHOUT sessionId — should use client.sessionId
      sendJson(ws, { type: 'chat', message: 'no explicit sid' });
      const done = await waitForMessage(messages, 'sdk_done');
      expect(done.sessionId).toBe('fallback-s1');

      ws.close();
    });

    it('session_status broadcasts carry the correct sessionId', async () => {
      const clientA = await createWsClient();
      await waitForMessage(clientA.messages, 'connected');
      sendJson(clientA.ws, { type: 'set_active_session', sessionId: 'status-s1' });
      await waitForMessage(clientA.messages, 'set_active_session_ack');

      // Client B on different session — should still get session_status (broadcast to all)
      const clientB = await createWsClient();
      await waitForMessage(clientB.messages, 'connected');
      sendJson(clientB.ws, { type: 'set_active_session', sessionId: 'status-s2' });
      await waitForMessage(clientB.messages, 'set_active_session_ack');

      mockExecuteQuery.mockImplementationOnce(async function* () {
        yield { type: 'assistant', uuid: 'st1', message: { content: [{ type: 'text', text: 'x' }] } };
      });

      sendJson(clientA.ws, { type: 'chat', message: 'status test', sessionId: 'status-s1' });

      // Both clients should get session_status with streaming then idle
      const statusA = await waitForMessage(clientA.messages, 'session_status');
      expect(statusA.sessionId).toBe('status-s1');

      // Client B should also get session_status (broadcastToAll) with correct sessionId
      const statusB = await waitForMessage(clientB.messages, 'session_status');
      expect(statusB.sessionId).toBe('status-s1');

      clientA.ws.close();
      clientB.ws.close();
    });
  });
});
