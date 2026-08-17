/**
 * Owns: periodic disk → manifest reconciliation. Safety net for sites the
 *   PostToolUse hook missed (backend was down during creation, sites made
 *   via Bash/ssh/cron, etc.).
 * Public API: startReconciler / stopReconciler — wired in index.ts boot.
 * See README.md.
 */
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../config.js';
import { registerSiteInManifest, deriveProjectFromPath, isValidSlug } from './register.js';

const SITES_DIR = () => path.join(config.workspaceRoot, 'published', 'sites');
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FIRST_RUN_DELAY_MS = 30 * 1000;   // 30 s after boot — let other init finish

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * One reconciliation pass. Lists disk dirs, registers any not yet in manifest.
 * For symlink entries, derives project from the resolved target so hybrid-
 * storage sites get attribution even without the AI hook firing.
 */
async function tick(): Promise<{ scanned: number; registered: number; errors: number }> {
  let scanned = 0, registered = 0, errors = 0;
  try {
    const entries = await fs.readdir(SITES_DIR(), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || !isValidSlug(e.name)) continue;
      scanned++;
      const full = path.join(SITES_DIR(), e.name);
      let project: string | undefined;
      try {
        const lst = await fs.lstat(full);
        if (lst.isSymbolicLink()) {
          // Resolve to absolute target so deriveProjectFromPath sees the
          // workspace/projects/<p>/ pattern. realpath fails on broken symlinks
          // — fall back to readlink which still gives the intended path string.
          let target: string | undefined;
          try { target = await fs.realpath(full); }
          catch { try { target = await fs.readlink(full); } catch { /* skip */ } }
          project = deriveProjectFromPath(target);
        } else if (!lst.isDirectory()) {
          continue; // Skip plain files (robots.txt etc.)
        }
      } catch { errors++; continue; }
      const r = await registerSiteInManifest(e.name, project);
      if (r.action === 'promoted' || r.action === 'filled') registered++;
    }
  } catch (err: unknown) {
    // SITES_DIR doesn't exist yet — nothing to reconcile, not an error
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      errors++;
      console.warn(`[publishing-reconciler] tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { scanned, registered, errors };
}

export function startReconciler(): void {
  if (timer) return;
  // Defer first run so backend boot finishes — manifest writes during
  // restart can collide with deploy verification.
  setTimeout(() => {
    void tick().then(r => {
      if (r.registered > 0) {
        console.log(`[publishing-reconciler] first pass: scanned=${r.scanned} registered=${r.registered}`);
      }
    });
    timer = setInterval(() => {
      void tick().then(r => {
        if (r.registered > 0) {
          console.log(`[publishing-reconciler] tick: scanned=${r.scanned} registered=${r.registered}`);
        }
      });
    }, TICK_INTERVAL_MS);
    timer?.unref();
  }, FIRST_RUN_DELAY_MS);
}

export function stopReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exported for tests / one-off ops scripts (e.g., manual backfill from CLI).
export const _internal = { tick };
