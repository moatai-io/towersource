// Owns interactive AskUserQuestion routing shared by ws-handler chat turns,
// auto-resume turns, and background agent runs (spawn/send/wake, task-runner).
//
// Why this module exists (GitHub issue #218): previously only ws-handler-owned
// turns could surface an interactive question card. Background runners stubbed
// `askUser` with `async () => 'skip'`, so approval-gated tools (deliver_file,
// deliver_directory, import_personal_file_to_project) never showed a card and
// misread 'skip' as an unknown answer → APPROVAL_INVALID_ANSWER. Routing every
// run through one pendingQuestions registry lets the session owner answer from
// any open tab — the same contract the auto-resume path already used.

import { queryOne } from '../../db/pg-repo.js';
import { setAgentTurnWaitingUser } from '../agent-turn/turn-supervisor.js';

export interface PendingQuestion {
  questionId: string;
  sessionId: string;
  questions: any[];
  recipientUserId?: number;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// 60 minutes — product UI treats AskUserQuestion as awaiting_user, not a short-lived prompt.
export const ASK_USER_TIMEOUT_MS = 60 * 60 * 1000;

const pendingQuestions = new Map<string, PendingQuestion>(); // questionId → PendingQuestion

export interface PendingQuestionBroadcasts {
  toUser: (userId: number, data: any) => void;
}

let broadcasts: PendingQuestionBroadcasts | null = null;

/**
 * Called once by ws-handler bootstrap so question cards reach open tabs.
 * WS broadcasts are a ws-handler concern (local client fan-out + ws-sync
 * publish); this module must not import ws-handler (spawn-rpc would cycle).
 */
export function wirePendingQuestionBroadcasts(next: PendingQuestionBroadcasts): void {
  broadcasts = next;
}

function normalizeAskUserQuestionText(q: any): string {
  if (typeof q === 'string') return q.trim();
  if (!q || typeof q !== 'object') return '';
  for (const key of ['question', 'title', 'prompt', 'label']) {
    const value = q[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

export function sanitizeAskUserQuestions(questions: any[]): any[] {
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q) => {
      const question = normalizeAskUserQuestionText(q);
      if (!question) return null;
      const raw = q && typeof q === 'object' ? q : {};
      const options = Array.isArray(raw.options)
        ? raw.options
            .map((opt: any) => {
              if (typeof opt === 'string') {
                const label = opt.trim();
                return label ? { label } : null;
              }
              if (!opt || typeof opt !== 'object') return null;
              const label = typeof opt.label === 'string' && opt.label.trim().length > 0
                ? opt.label.trim()
                : (typeof opt.value === 'string' && opt.value.trim().length > 0 ? opt.value.trim() : '');
              if (!label) return null;
              return {
                ...opt,
                label,
                description: typeof opt.description === 'string' ? opt.description : undefined,
              };
            })
            .filter(Boolean)
        : [];
      return {
        ...raw,
        question,
        options,
      };
    })
    .filter(Boolean) as any[];
}

export function getLocalPendingQuestion(sessionId: string): { questionId: string; questions: any[]; recipientUserId?: number } | null {
  for (const pq of pendingQuestions.values()) {
    if (pq.sessionId === sessionId) {
      return { questionId: pq.questionId, questions: pq.questions, recipientUserId: pq.recipientUserId };
    }
  }
  return null;
}

export function listPendingQuestionsForUser(userId: number | undefined) {
  return [...pendingQuestions.values()].filter(pq => userId !== undefined && pq.recipientUserId === userId)
    .map(pq => ({ sessionId: pq.sessionId, questionId: pq.questionId }));
}

export function resolvePendingQuestionLocally(questionId: string | undefined, answer: string, sessionId?: string, userId?: number): boolean {
  const pq = questionId ? pendingQuestions.get(questionId) : undefined;
  if (!pq || (sessionId && pq.sessionId !== sessionId) || pq.recipientUserId !== userId) return false;
  pq.resolve(answer);
  return true;
}

export function cancelPendingQuestionsForSession(sessionId: string, reason: string): boolean {
  let cancelled = false;
  for (const [questionId, pq] of pendingQuestions.entries()) {
    if (pq.sessionId !== sessionId) continue;
    clearTimeout(pq.timer);
    pendingQuestions.delete(questionId);
    pq.reject(new Error(reason));
    cancelled = true;
  }
  return cancelled;
}

/** Interactive-chat timeout: the user is usually still around, so push the model to re-ask visibly. */
export function chatTimeoutMessage(questionSummary: string): string {
  return (
    `[System] The user did not respond to the interactive prompt within 60 minutes. They may have switched to another session or missed it. ` +
    `Your question was: "${questionSummary}". ` +
    `Do NOT proceed silently. Instead, ask the same question again as a regular chat message so the user can see it when they return. ` +
    `Keep your message concise and clear.`
  );
}

/** Background-run timeout: nobody may be watching, so keep the guidance minimal. */
export function backgroundTimeoutMessage(questionSummary: string): string {
  return (
    `[System] The user did not respond to the interactive prompt within 60 minutes. ` +
    `Your question was: "${questionSummary}". ` +
    `Ask the same question again as a regular chat message if it is still needed.`
  );
}

export interface SessionAskUserOptions {
  sessionId: string;
  recipientUserId?: number;
  /** Root turn / user message id used for durable waiting_user bookkeeping. */
  userMessageId?: string | null;
  /** Log prefix, e.g. 'ws', 'auto-resume', 'spawn-rpc', 'task-runner'. */
  logTag: string;
  timeoutMessage?: (questionSummary: string) => string;
}

/**
 * Build an EngineCallbacks['askUser'] that registers the question in the shared
 * registry and broadcasts `ask_user` to the session owner's open tabs. Works for
 * interactive turns and headless background runs alike: the answer arrives via
 * the normal `answer_question` WS flow (or a remote node's ws-sync forward).
 */
export function createSessionAskUser(opts: SessionAskUserOptions): (questionId: string, questions: any[]) => Promise<string> {
  const { sessionId, userMessageId, logTag } = opts;
  const timeoutMessage = opts.timeoutMessage || chatTimeoutMessage;
  return async (questionId: string, questions: any[]) => {
    const recipientUserId = opts.recipientUserId ?? (await queryOne<{ user_id: number | null }>(
      'SELECT user_id FROM sessions WHERE id = $1', [sessionId],
    ))?.user_id ?? undefined;
    const deliver = (data: any) => {
      if (recipientUserId !== undefined) broadcasts?.toUser(recipientUserId, { ...data, recipientUserId });
    };
    const sanitizedQuestions = sanitizeAskUserQuestions(questions);
    if (sanitizedQuestions.length === 0) {
      console.warn(`[${logTag}] ask_user dropped empty payload for session=${sessionId.slice(0, 8)}`);
      return Promise.resolve('No user question payload was provided. Continue without waiting for user input.');
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pq = pendingQuestions.get(questionId);
        if (pq) {
          pendingQuestions.delete(questionId);
          if (userMessageId) void setAgentTurnWaitingUser(userMessageId, false).catch(() => {});
          deliver({ type: 'session_awaiting_user', sessionId, awaiting: false, questionId });
          deliver({ type: 'ask_user_timeout', sessionId, questionId });
          const questionSummary = sanitizedQuestions.map((q: any) => q.question).join(', ');
          resolve(timeoutMessage(questionSummary));
        }
      }, ASK_USER_TIMEOUT_MS);

      if (userMessageId) void setAgentTurnWaitingUser(userMessageId, true).catch(() => {});
      pendingQuestions.set(questionId, {
        questionId,
        sessionId,
        recipientUserId,
        questions: sanitizedQuestions,
        resolve: (answer: string) => {
          clearTimeout(timer);
          pendingQuestions.delete(questionId);
          if (userMessageId) void setAgentTurnWaitingUser(userMessageId, false).catch(() => {});
          deliver({ type: 'session_awaiting_user', sessionId, awaiting: false, questionId });
          resolve(answer);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          pendingQuestions.delete(questionId);
          deliver({ type: 'session_awaiting_user', sessionId, awaiting: false, questionId });
          reject(error);
        },
        timer,
      });

      // Both payload and attention belong only to the execution recipient.
      // The frontend renders a popup only when viewing the originating session.
      deliver({ type: 'session_awaiting_user', sessionId, awaiting: true, questionId });
      deliver({
        type: 'ask_user',
        sessionId,
        questionId,
        questions: sanitizedQuestions,
      });
    });
  };
}
