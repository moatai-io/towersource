import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setAgentTurnWaitingUser = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(async () => ({ user_id: 7 })) }));

vi.mock('../agent-turn/turn-supervisor.js', () => ({ setAgentTurnWaitingUser }));

const {
  ASK_USER_TIMEOUT_MS,
  backgroundTimeoutMessage,
  cancelPendingQuestionsForSession,
  chatTimeoutMessage,
  createSessionAskUser,
  getLocalPendingQuestion,
  listPendingQuestionsForUser,
  resolvePendingQuestionLocally,
  sanitizeAskUserQuestions,
  wirePendingQuestionBroadcasts,
} = await import('./pending-questions.js');

function wire() {
  const toAll = vi.fn();
  const toSession = vi.fn();
  wirePendingQuestionBroadcasts({ toUser: toSession });
  return { toAll, toSession };
}

describe('pending-questions shared ask_user routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wire();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('broadcasts ask_user to the session owner and resolves the local answer', async () => {
    const { toAll, toSession } = wire();
    const askUser = createSessionAskUser({ recipientUserId: 7, sessionId: 'session-a', userMessageId: 'turn-1', logTag: 'test' });

    const answerPromise = askUser('q-1', [{
      question: '폴터를 전달할까요?',
      header: '폴터 전달 승인',
      options: [{ label: '폴터 전달 승인', description: '복사를 승인합니다.' }, { label: '취소' }],
    }]);

    expect(toAll).not.toHaveBeenCalled();
    expect(setAgentTurnWaitingUser).toHaveBeenCalledWith('turn-1', true);
    expect(toSession).toHaveBeenCalledWith(7, { recipientUserId: 7, type: 'session_awaiting_user', sessionId: 'session-a', awaiting: true, questionId: 'q-1' });
    expect(toSession).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'ask_user', questionId: 'q-1' }));
    expect(getLocalPendingQuestion('session-a')?.questionId).toBe('q-1');

    expect(resolvePendingQuestionLocally('q-1', '폴터 전달 승인', 'session-a', 7)).toBe(true);
    await expect(answerPromise).resolves.toBe('폴터 전달 승인');
    expect(getLocalPendingQuestion('session-a')).toBeNull();
  });

  it('requires the exact question, session and recipient', async () => {
    const askUser = createSessionAskUser({ recipientUserId: 7, sessionId: 'session-b', logTag: 'test' });
    const answerPromise = askUser('q-2', ['진행할까요?']);

    expect(resolvePendingQuestionLocally(undefined, '네', 'session-b', 7)).toBe(false);
    expect(resolvePendingQuestionLocally('q-2', '네', 'session-b', 8)).toBe(false);
    expect(resolvePendingQuestionLocally('q-2', '네', 'other', 7)).toBe(false);
    expect(listPendingQuestionsForUser(8)).toEqual([]);
    expect(listPendingQuestionsForUser(7)).toContainEqual({ sessionId: 'session-b', questionId: 'q-2' });
    expect(resolvePendingQuestionLocally('q-2', '네', 'session-b', 7)).toBe(true);
    await expect(answerPromise).resolves.toBe('네');
  });

  it('rejects pending questions for a cancelled session', async () => {
    const askUser = createSessionAskUser({ recipientUserId: 7, sessionId: 'session-c', logTag: 'test' });
    const answerPromise = askUser('q-3', ['계속할까요?']);
    const rejection = expect(answerPromise).rejects.toThrow('Session aborted');

    expect(cancelPendingQuestionsForSession('session-c', 'Session aborted')).toBe(true);
    await rejection;
    expect(getLocalPendingQuestion('session-c')).toBeNull();
  });

  it('times out with the background guidance and clears awaiting state', async () => {
    const { toAll, toSession } = wire();
    const askUser = createSessionAskUser({
      recipientUserId: 7, sessionId: 'session-d',
      userMessageId: 'turn-9',
      logTag: 'spawn-rpc',
      timeoutMessage: backgroundTimeoutMessage,
    });
    const answerPromise = askUser('q-4', ['배포할까요?']);

    await vi.advanceTimersByTimeAsync(ASK_USER_TIMEOUT_MS + 10);

    const answer = await answerPromise;
    expect(answer).toContain('did not respond');
    expect(answer).toContain('배포할까요?');
    expect(setAgentTurnWaitingUser).toHaveBeenCalledWith('turn-9', false);
    expect(toSession).toHaveBeenCalledWith(7, { recipientUserId: 7, type: 'session_awaiting_user', sessionId: 'session-d', awaiting: false, questionId: 'q-4' });
    expect(toSession).toHaveBeenCalledWith(7, { recipientUserId: 7, type: 'ask_user_timeout', sessionId: 'session-d', questionId: 'q-4' });
  });

  it('returns the unavailable sentinel for empty question payloads without waiting', async () => {
    const { toSession } = wire();
    const askUser = createSessionAskUser({ recipientUserId: 7, sessionId: 'session-e', logTag: 'test' });

    await expect(askUser('q-5', [{ header: 'no question text' }])).resolves.toContain('No user question payload');
    expect(toSession).not.toHaveBeenCalled();
    expect(getLocalPendingQuestion('session-e')).toBeNull();
  });

  it('sanitizes options and keeps question text like the legacy ws-handler helper', () => {
    const sanitized = sanitizeAskUserQuestions([
      { question: ' 진행? ', options: [{ label: ' 승인 ', description: 'go' }, { value: '거절' }, '', { label: ' ' }] },
      { title: 'fallback title' },
      { header: 'only header' },
    ]);

    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]).toMatchObject({ question: '진행?', options: [{ label: '승인', description: 'go' }, { label: '거절' }] });
    expect(sanitized[1]).toMatchObject({ question: 'fallback title', options: [] });
  });

  it('chatTimeoutMessage keeps the interactive re-ask guidance', () => {
    expect(chatTimeoutMessage('계속할까요?')).toContain('Do NOT proceed silently');
  });
});
