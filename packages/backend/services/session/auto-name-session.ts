import { getSession } from './session-manager.js';
import { getMessages } from '../message-store.js';
import { extractTextFromContent } from '../../utils/text.js';
import { generateSessionNameResult } from '../auto-namer.js';
import { queryOne } from '../../db/pg-repo.js';

type Result = { status: 'generated'; name: string } | { status: 'skipped' | 'retryable' };
const inFlight = new Map<string, Promise<Result>>();
// Process-local FIFO for title jobs only. Keep the slot through retries and
// persistence; do not release it while an upstream call is still running.
let queueTail: Promise<void> = Promise.resolve();

/** Coalesce same-session requests and serialize title jobs across sessions. */
export function autoNameSession(sessionId: string): Promise<Result> {
  const running = inFlight.get(sessionId);
  if (running) return running;
  const work = queueTail.then(() => generateAndSave(sessionId))
    .finally(() => inFlight.delete(sessionId));
  // A rejected job must not poison the queue for subsequent sessions.
  queueTail = work.then(() => undefined, () => undefined);
  inFlight.set(sessionId, work);
  return work;
}

async function generateAndSave(sessionId: string): Promise<Result> {
  const session = await getSession(sessionId);
  if (!session || session.autoNamed === 0 ||
      !(session.name?.startsWith('Session ') || session.name === 'New thread')) {
    return { status: 'skipped' };
  }
  const messages = await getMessages(sessionId);
  const user = messages.find(m => m.role === 'user');
  const assistant = messages.find(m => m.role === 'assistant');
  if (!user || !assistant) return { status: 'skipped' };

  // Never persist fallback as success. Retry once, then retain the default name
  // so the next completed turn or reconnect can try again.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const result = await generateSessionNameResult(
      extractTextFromContent(user.content), extractTextFromContent(assistant.content), sessionId,
    );
    if (!result.generated) continue;
    // Compare-and-set also protects manual renames and other backend processes.
    const saved = await queryOne<{ name: string }>(
      `UPDATE sessions SET name = $2, auto_named = 1
       WHERE id = $1 AND name = $3 AND COALESCE(auto_named, 1) <> 0
       RETURNING name`,
      [sessionId, result.name, session.name],
    );
    return saved ? { status: 'generated', name: saved.name } : { status: 'skipped' };
  }
  return { status: 'retryable' };
}
