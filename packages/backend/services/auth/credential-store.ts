/**
 * Claude Account Credential Store
 *
 * Manages multiple Claude Max/Pro accounts for project-based credential rotation.
 * Each account has its own CLAUDE_CONFIG_DIR with separate OAuth tokens.
 *
 * When no accounts are registered, returns undefined → SDK uses default ~/.claude/
 *
 * 2026-05-07: addAccount() now also runs prepareAccountAssetSymlinks() to
 * symlink shared user-level assets (skills/, agents/, hooks/, scripts/,
 * CLAUDE.md, settings*.json, keybindings.json, statusline) from the default
 * account's configDir into the new one. Without this, a freshly-registered
 * account boots up missing all hooks (memory, workspace-guard) and user
 * skills — the AI sees only SDK built-ins. See decision doc
 * 2026-05-07-claude-account-asset-symlinks.md.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { query, queryOne, execute } from '../../db/pg-repo.js';

export interface ClaudeAccount {
  id: string;
  label: string;
  configDir: string;
  tier: 'max' | 'pro' | 'api';
  isDefault: boolean;
  enabled: boolean;
  createdAt?: string;
}

// ── CRUD ──

export async function listAccounts(): Promise<ClaudeAccount[]> {
  const rows = await query(
    'SELECT * FROM claude_accounts ORDER BY is_default DESC, created_at ASC'
  );
  return rows.map(mapRow);
}

export async function getAccount(id: string): Promise<ClaudeAccount | null> {
  const row = await queryOne('SELECT * FROM claude_accounts WHERE id = $1', [id]);
  return row ? mapRow(row) : null;
}

export async function addAccount(account: {
  id: string;
  label: string;
  configDir: string;
  tier?: string;
  isDefault?: boolean;
}): Promise<ClaudeAccount> {
  // If setting as default, clear existing default first
  if (account.isDefault) {
    await execute('UPDATE claude_accounts SET is_default = false WHERE is_default = true');
  }
  await execute(
    `INSERT INTO claude_accounts (id, label, config_dir, tier, is_default)
     VALUES ($1, $2, $3, $4, $5)`,
    [account.id, account.label, account.configDir, account.tier || 'max', account.isDefault ?? false]
  );

  // Wire shared user-level assets so the new account isn't missing skills/hooks/CLAUDE.md.
  // Failures are logged but never block account creation — the row is the source of truth;
  // assets can be reconciled later via reconcileAccountAssetSymlinks().
  try {
    const result = await prepareAccountAssetSymlinks(account.configDir);
    if (result.linked.length > 0 || result.backedUp.length > 0) {
      console.log(
        `[claude-accounts] prep ${account.id} (${account.configDir}): ` +
        `linked=${result.linked.length}, backed_up=${result.backedUp.length}, ` +
        `skipped=${result.skipped.length}`
      );
    }
  } catch (err: any) {
    console.warn(`[claude-accounts] prep failed for ${account.id}: ${err.message}`);
  }

  return (await getAccount(account.id))!;
}

export async function updateAccount(id: string, updates: {
  label?: string;
  configDir?: string;
  tier?: string;
  isDefault?: boolean;
  enabled?: boolean;
}): Promise<ClaudeAccount | null> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (updates.label !== undefined) { sets.push(`label = $${idx++}`); params.push(updates.label); }
  if (updates.configDir !== undefined) { sets.push(`config_dir = $${idx++}`); params.push(updates.configDir); }
  if (updates.tier !== undefined) { sets.push(`tier = $${idx++}`); params.push(updates.tier); }
  if (updates.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(updates.enabled); }

  if (updates.isDefault === true) {
    await execute('UPDATE claude_accounts SET is_default = false WHERE is_default = true');
    sets.push(`is_default = $${idx++}`); params.push(true);
  } else if (updates.isDefault === false) {
    sets.push(`is_default = $${idx++}`); params.push(false);
  }

  if (sets.length === 0) return getAccount(id);

  params.push(id);
  await execute(`UPDATE claude_accounts SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  return getAccount(id);
}

export async function removeAccount(id: string): Promise<boolean> {
  // Clear project references first (ON DELETE SET NULL handles this, but be explicit)
  await execute('UPDATE projects SET claude_account_id = NULL WHERE claude_account_id = $1', [id]);
  const result = await execute('DELETE FROM claude_accounts WHERE id = $1', [id]);
  return result.changes > 0;
}

// ── Core: resolve configDir for a project ──

/**
 * Get the CLAUDE_CONFIG_DIR for a given project.
 *
 * Resolution order:
 * 1. Project's assigned account (if enabled)
 * 2. Default account (is_default = true, if enabled)
 * 3. undefined → SDK uses process.env / ~/.claude/ (existing behavior)
 */
export async function getConfigDir(projectId?: string | null): Promise<string | undefined> {
  if (projectId) {
    const row = await queryOne(
      `SELECT ca.config_dir FROM projects p
       JOIN claude_accounts ca ON p.claude_account_id = ca.id
       WHERE p.id = $1 AND ca.enabled = true`,
      [projectId]
    );
    if (row) return (row as any).config_dir;
  }

  // Fallback to default account
  const defaultRow = await queryOne(
    'SELECT config_dir FROM claude_accounts WHERE is_default = true AND enabled = true'
  );
  if (defaultRow) return (defaultRow as any).config_dir;

  // No accounts registered → use existing behavior
  return undefined;
}

// ── Project ↔ Account assignment ──

export async function assignAccountToProject(projectId: string, accountId: string | null): Promise<void> {
  await execute(
    'UPDATE projects SET claude_account_id = $1 WHERE id = $2',
    [accountId, projectId]
  );
}

export async function getProjectAccountId(projectId: string): Promise<string | null> {
  const row = await queryOne('SELECT claude_account_id FROM projects WHERE id = $1', [projectId]);
  return (row as any)?.claude_account_id || null;
}

// ── Helpers ──

function mapRow(row: any): ClaudeAccount {
  return {
    id: row.id,
    label: row.label,
    configDir: row.config_dir,
    tier: row.tier || 'max',
    isDefault: !!row.is_default,
    enabled: row.enabled !== false,
    createdAt: row.created_at,
  };
}

// ── Shared asset symlinking ──

/**
 * Asset names that are SHARED across all accounts (Tower-wide infra) and so
 * should be symlinked from the source configDir into a new one.
 *
 * NOT in this list = account-private (credentials, sessions, plugin cache,
 * memory, marketplace state, etc.) — those must remain physically separate
 * per account or multi-tenant isolation breaks.
 *
 * Add cautiously. The rule of thumb: if it's the same regardless of which
 * Claude account is logged in, it goes here.
 */
const SHARED_ASSETS = [
  'skills',               // ~/.claude/skills/<name>/SKILL.md — user skill library
  'agents',               // ~/.claude/agents/ — agent defs
  'hooks',                // settings.json hooks reference scripts in here
  'scripts',              // shell scripts referenced by hooks and browser/live helpers
  'CLAUDE.md',            // global memory injected by SDK when settingSources='user'
  'settings.json',        // hooks/env/permissions/enabledPlugins
  'settings.local.json',  // local mcpServers, machine-specific allows
  'keybindings.json',     // key bindings
  'statusline',           // status bar binary
] as const;

interface SymlinkResult {
  /** Items newly symlinked into target. */
  linked: string[];
  /** Items already correctly symlinked — no-op. */
  skipped: string[];
  /** Items that existed as real files/dirs and were moved aside before symlinking. */
  backedUp: string[];
  /** Items not linked because the source side doesn't exist. */
  missingSource: string[];
}

/**
 * Resolve the source configDir for shared assets — the default account's
 * configDir, or `~/.claude` as last-resort fallback.
 *
 * Note: when no accounts are registered yet (bootstrap), or the default has
 * been removed, falls back to `os.homedir()/.claude` — matches the implicit
 * behavior of the SDK pre-credential-rotation.
 */
export async function getSharedAssetSourceDir(): Promise<string> {
  const row = await queryOne<{ config_dir: string }>(
    'SELECT config_dir FROM claude_accounts WHERE is_default = true AND enabled = true'
  );
  if (row?.config_dir && fs.existsSync(row.config_dir)) {
    return row.config_dir;
  }
  return path.join(os.homedir(), '.claude');
}

/**
 * Prepare a fresh account configDir by symlinking shared Tower-wide assets
 * from the source (default) configDir.
 *
 * Idempotent. Behaviors:
 *   - target dir doesn't exist → create it
 *   - target item is already a symlink to the source → skip
 *   - target item is a wrong symlink → replace
 *   - target item is a real file/dir → move to backups/pre-symlink-<ts>/, then link
 *   - source item doesn't exist → record as missingSource, skip
 *
 * Same target as itself (sourceDir === targetConfigDir) → no-op (returns empty).
 * This guards against accidentally self-linking the source.
 */
export async function prepareAccountAssetSymlinks(
  targetConfigDir: string,
  opts?: { sourceConfigDir?: string },
): Promise<SymlinkResult> {
  const result: SymlinkResult = { linked: [], skipped: [], backedUp: [], missingSource: [] };

  const sourceDir = opts?.sourceConfigDir ?? await getSharedAssetSourceDir();
  const resolvedSource = path.resolve(sourceDir);
  const resolvedTarget = path.resolve(targetConfigDir);

  if (resolvedSource === resolvedTarget) {
    return result;
  }

  if (!fs.existsSync(resolvedTarget)) {
    fs.mkdirSync(resolvedTarget, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(resolvedTarget, 'backups', `pre-symlink-${ts}`);
  let backupCreated = false;
  const ensureBackupDir = () => {
    if (!backupCreated) {
      fs.mkdirSync(backupDir, { recursive: true });
      backupCreated = true;
    }
  };

  for (const item of SHARED_ASSETS) {
    const src = path.join(resolvedSource, item);
    const dst = path.join(resolvedTarget, item);

    if (!fs.existsSync(src)) {
      result.missingSource.push(item);
      continue;
    }

    let dstStat: fs.Stats | null = null;
    try { dstStat = fs.lstatSync(dst); } catch { /* doesn't exist */ }

    if (dstStat?.isSymbolicLink()) {
      // Check whether it already points where we want.
      let currentTarget: string | null = null;
      try { currentTarget = fs.readlinkSync(dst); } catch { /* broken */ }
      if (currentTarget === src) {
        result.skipped.push(item);
        continue;
      }
      // Wrong symlink — remove and replace.
      fs.unlinkSync(dst);
    } else if (dstStat) {
      // Real file or directory — move into backup.
      ensureBackupDir();
      fs.renameSync(dst, path.join(backupDir, item));
      result.backedUp.push(item);
    }

    fs.symlinkSync(src, dst);
    result.linked.push(item);
  }

  return result;
}

/**
 * Reconcile shared asset symlinks across all registered accounts.
 *
 * Useful at startup or when SHARED_ASSETS list grows. Idempotent — already
 * correct symlinks are skipped. The default account is not touched (it is
 * the source).
 */
export async function reconcileAccountAssetSymlinks(): Promise<{
  account: string;
  result: SymlinkResult;
}[]> {
  const accounts = await listAccounts();
  const sourceDir = await getSharedAssetSourceDir();
  const out: { account: string; result: SymlinkResult }[] = [];

  for (const acc of accounts) {
    if (path.resolve(acc.configDir) === path.resolve(sourceDir)) continue;
    try {
      const result = await prepareAccountAssetSymlinks(acc.configDir, { sourceConfigDir: sourceDir });
      out.push({ account: acc.id, result });
    } catch (err: any) {
      console.warn(`[claude-accounts] reconcile failed for ${acc.id}: ${err.message}`);
    }
  }

  return out;
}
