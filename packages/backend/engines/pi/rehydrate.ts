// Owns Tower-message → Pi-session-file rehydration for engine hard switch.
// Public API: rehydratePiSessionFromMessages.

import fs from 'fs';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { RehydrateInputMessage } from '../types.js';

/**
 * Create a file-backed Pi session from chronological Tower DB messages without
 * touching the Pi runtime or making an LLM call.
 */
export async function rehydratePiSessionFromMessages(
  sessionId: string,
  messages: ReadonlyArray<RehydrateInputMessage>,
  cwd: string,
): Promise<string> {
  // Lazy import — keeps the conversion module out of the hot path for normal runs.
  const { convertTowerMessagesToPi } = await import('../conversion/tower-to-pi.js');

  const piSessionDir = path.join(cwd, '.pi', 'sessions');
  fs.mkdirSync(piSessionDir, { recursive: true });

  const sessionMgr = SessionManager.create(cwd, piSessionDir);

  const piMessages = convertTowerMessagesToPi(messages, {
    sessionFilePath: sessionMgr.getSessionFile() || undefined,
  });
  for (const msg of piMessages) {
    try {
      sessionMgr.appendMessage(msg as any);
    } catch (err: any) {
      // One malformed entry shouldn't sink the whole rehydrate; warn and continue.
      // The next valid entry preserves the chronological chain.
      console.warn(`[Pi] rehydrate: skipped invalid message (role=${(msg as any).role}): ${err.message}`);
    }
  }

  const sessionFile = sessionMgr.getSessionFile();
  if (!sessionFile) {
    throw new Error(`[Pi] rehydrate failed: SessionManager.create returned no sessionFile for cwd=${cwd}`);
  }

  // SDK invariant — SessionManager._persist defers writing entries to disk
  // until the first ASSISTANT message arrives in the in-memory buffer.
  // For the production hard-switch flow this is a non-issue: callers only
  // switch at an idle boundary where the last DB message is assistant text
  // (decision §"핵심 원칙" #4), so the flush happens during this call.
  // If somehow this method is invoked with a user-only or empty sequence,
  // the path is still committed and the bytes land on the next assistant
  // turn. Tower's `messages` table is source of truth either way.
  console.log(`[Pi] Rehydrated session ${sessionId.slice(0, 8)} from ${messages.length} Tower messages (${piMessages.length} Pi entries) → ${sessionFile}`);
  return sessionFile;
}
