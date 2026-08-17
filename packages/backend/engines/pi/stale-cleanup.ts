// Owns cleanup of stale Pi ephemeral files from previous server runs.
// Public API: cleanupStalePiForkSessions.

import fs from 'fs';
import path from 'path';

/**
 * Clean up stale fork session files, scratchpad data, and task lists.
 * Fork sessions are ephemeral — if the server crashed mid-fork, leftover
 * files accumulate in `.pi/sessions/forks/` and related scratch areas.
 */
export function cleanupStalePiForkSessions(): void {
  const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  const dirsToClean = [
    path.join(process.cwd(), '.pi', 'sessions', 'forks'),
    path.join(process.cwd(), '.pi', 'scratchpad'),
  ];

  for (const dir of dirsToClean) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let cleaned = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > STALE_THRESHOLD_MS) {
            if (entry.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
            cleaned++;
          }
        } catch { /* skip files that can't be stat'd */ }
      }
      if (cleaned > 0) {
        console.log(`[Pi] Cleaned ${cleaned} stale files from ${dir}`);
      }
    } catch { /* skip if dir is unreadable */ }
  }

  // Also clean stale task lists (but NOT active ones)
  const taskDir = path.join(process.cwd(), '.pi', 'tasks');
  if (fs.existsSync(taskDir)) {
    try {
      const taskLists = fs.readdirSync(taskDir, { withFileTypes: true });
      let cleaned = 0;
      for (const entry of taskLists) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(taskDir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > STALE_THRESHOLD_MS) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch { /* skip */ }
      }
      if (cleaned > 0) {
        console.log(`[Pi] Cleaned ${cleaned} stale task list(s) from ${taskDir}`);
      }
    } catch { /* skip */ }
  }
}
