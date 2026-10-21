// Owns native Pi session cloning while preserving compaction and branch state.
// Public API: clonePiSessionFile.

import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

/**
 * Fork a native Pi session into a new independent file in the same Project.
 * SessionManager.forkFrom rewrites the header with a new native id while keeping
 * compaction entries and the active branch intact.
 */
export function clonePiSessionFile(sourceSessionFile: string, cwd: string): string {
  const sessionDir = path.join(cwd, '.pi', 'sessions');
  const forked = SessionManager.forkFrom(sourceSessionFile, cwd, sessionDir);
  const sessionFile = forked.getSessionFile();
  if (!sessionFile) {
    throw new Error(`Pi clone failed: forkFrom returned no session file for ${sourceSessionFile}`);
  }
  return sessionFile;
}
