import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// GitHub issue #218 — example-org APPROVAL_INVALID_ANSWER (skip) root cause:
// background runners (spawn child, send_to_session, wake, scheduled tasks) used
// `askUser: async () => 'skip'`, so approval-gated file-exchange tools never
// surfaced a question card and classified 'skip' as an unknown answer.
// These contracts keep every background run on the shared pending-questions
// registry so the session owner can actually answer from an open tab.

const SPAWN_RPC_PATH = new URL('../services/session/spawn-rpc.ts', import.meta.url);
const TASK_RUNNER_PATH = new URL('../services/task/task-runner.ts', import.meta.url);
const WS_HANDLER_PATH = new URL('./ws-handler.ts', import.meta.url);
const PENDING_PATH = new URL('../services/session/pending-questions.ts', import.meta.url);

describe('background ask_user routing (issue #218)', () => {
  it('spawn-rpc child/send/wake runners route ask_user through the shared registry, never a skip stub', () => {
    const src = readFileSync(SPAWN_RPC_PATH, 'utf8');
    expect(src).toContain("from './pending-questions.js'");
    expect(src).not.toMatch(/askUser:\s*async\s*\(\)\s*=>\s*'skip'/);
    // child session, send-to-session, and wake runners
    expect(src.match(/askUser: createSessionAskUser\(\{/g)).toHaveLength(3);
    expect(src).toMatch(/logTag: 'spawn-rpc'/);
    expect(src).toMatch(/logTag: 'spawn-rpc-send'/);
    expect(src).toMatch(/logTag: 'spawn-rpc-wake'/);
    expect(src).toMatch(/sessionId: req\.targetSessionId/);
    expect(src).toMatch(/sessionId: childSessionId/);
    expect(src).toMatch(/sessionId: parentSessionId/);
  });

  it('task-runner scheduled agents route ask_user through the shared registry', () => {
    const src = readFileSync(TASK_RUNNER_PATH, 'utf8');
    expect(src).toContain("from '../session/pending-questions.js'");
    expect(src).not.toMatch(/askUser:\s*async\s*\(\)\s*=>\s*'skip'/);
    expect(src).toMatch(/askUser: createSessionAskUser\(\{/);
    expect(src).toMatch(/logTag: 'task-runner'/);
  });

  it('ws-handler wires pending-question broadcasts once per websocket server', () => {
    const src = readFileSync(WS_HANDLER_PATH, 'utf8');
    expect(src).toMatch(/export function setupWebSocket[\s\S]{0,400}?wirePendingQuestionBroadcasts\(\{/);
    expect(src).not.toContain('const pendingQuestions = new Map');
    expect(src).not.toContain('const ASK_USER_TIMEOUT');
  });

  it('keeps question payloads and answers recipient-scoped including recovery', () => {
    const src = readFileSync(WS_HANDLER_PATH, 'utf8');
    expect(src).toContain('toUser: (userId, data) => broadcastToUser(userId, data)');
    expect(src).toContain('pending.recipientUserId !== client.userId');
    expect(src).toContain('listPendingQuestionsForUser(client.userId)');
    expect(src).toContain('snapshot.pendingQuestion.recipientUserId === client.userId');
    expect(src).toContain('return; // Recovery snapshots are server-internal');
    const pending = readFileSync(PENDING_PATH, 'utf8');
    expect(pending).not.toContain('broadcasts?.toAll');
    expect(pending).not.toContain('broadcasts?.toSession');
  });

  it('never opens a background question in the visible chat', () => {
    const runtime = readFileSync(new URL('../../frontend/src/hooks/useChatRuntime.ts', import.meta.url), 'utf8');
    const questionHandler = runtime.slice(runtime.indexOf("case 'ask_user':"), runtime.indexOf("case 'ask_user_timeout':"));
    expect(questionHandler).toContain('shouldDropSessionMessage');
    expect(questionHandler).not.toContain('if (!currentPendingQuestion)');
    const panel = readFileSync(new URL('../../frontend/src/components/chat/ChatPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('pendingQuestion?.sessionId === activeSessionId ? pendingQuestion : null');
  });

  it('the shared registry keeps timeout messages distinct for chat vs background runs', () => {
    const src = readFileSync(PENDING_PATH, 'utf8');
    expect(src).toContain('export function chatTimeoutMessage');
    expect(src).toContain('export function backgroundTimeoutMessage');
    expect(src).toContain('Do NOT proceed silently');
    expect(src).not.toMatch(/askUser:\s*async\s*\(\)\s*=>\s*'skip'/);
  });
});
