// Owns Pi SDK SessionManager creation/resume for Tower session startup.
// Public API: openOrCreatePiSessionManager.

import fs from 'fs';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { preparePiResumeSession } from '../../services/ai/pi-session-runtime.js';

export interface PiSessionManagerStartup {
  sessionMgr: ReturnType<typeof SessionManager.create>;
  resumeFailedMsg: null;
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
    .trim();
}

function isEmptyConnectionErrorAssistant(entry: any): boolean {
  const msg = entry?.type === 'message' ? entry.message : null;
  if (msg?.role !== 'assistant') return false;
  const hasContent = Array.isArray(msg.content) ? msg.content.length > 0 : Boolean(msg.content);
  if (hasContent) return false;
  if (msg.stopReason !== 'error') return false;
  return /^(connection error\.?|network error\.?)$/i.test(String(msg.errorMessage || '').trim());
}

function isSyntheticTransientContinuation(entry: any): boolean {
  const msg = entry?.type === 'message' ? entry.message : null;
  if (msg?.role !== 'user') return false;
  return messageText(msg).startsWith('The previous run was interrupted by a transient transport drop');
}

function repairTransientConnectionErrorTail(sessionMgr: ReturnType<typeof SessionManager.create>, sessionId: string): void {
  const getBranch = (sessionMgr as any).getBranch;
  const branchTo = (sessionMgr as any).branch;
  if (typeof getBranch !== 'function' || typeof branchTo !== 'function') return;

  const branch = getBranch.call(sessionMgr) as any[];
  let targetLeafId: string | null | undefined;
  let trimmed = 0;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (isEmptyConnectionErrorAssistant(entry) || isSyntheticTransientContinuation(entry)) {
      targetLeafId = entry.parentId ?? null;
      trimmed += 1;
      continue;
    }
    break;
  }

  if (trimmed > 0) {
    branchTo.call(sessionMgr, targetLeafId);
    console.warn(`[Pi] Repaired transient connection-error tail before resume: session=${sessionId.slice(0, 8)} trimmed=${trimmed} leaf=${targetLeafId || 'root'}`);
  }
}

/**
 * Open an existing Pi session file when Tower has one, otherwise create a new
 * file-backed SessionManager under `<cwd>/.pi/sessions`.
 */
export function openOrCreatePiSessionManager(params: {
  sessionId: string;
  cwd: string;
  engineSessionId?: string;
}): PiSessionManagerStartup {
  const { sessionId, cwd, engineSessionId } = params;

  const piSessionDir = path.join(cwd, '.pi', 'sessions');
  fs.mkdirSync(piSessionDir, { recursive: true });

  let sessionMgr: ReturnType<typeof SessionManager.create>;
  const resumeSessionFile = engineSessionId
    ? preparePiResumeSession(engineSessionId)
    : undefined;

  if (engineSessionId) {
    if (!resumeSessionFile) {
      throw new Error(`Previous Pi conversation could not be restored: session file or backup is missing (${engineSessionId})`);
    }
    try {
      sessionMgr = SessionManager.open(resumeSessionFile, piSessionDir);
      repairTransientConnectionErrorTail(sessionMgr, sessionId);
      console.log(`[Pi] Resuming session: ${sessionId.slice(0, 8)} from ${resumeSessionFile}`);
    } catch (err: any) {
      // Never replace a native Session with a blank file during resume. The DB
      // pointer and pinned Harness stay intact so a later repair can retry safely.
      throw new Error(`Previous Pi conversation could not be restored: ${err.message}`);
    }
  } else {
    sessionMgr = SessionManager.create(cwd, piSessionDir);
  }

  return { sessionMgr, resumeFailedMsg: null };
}
