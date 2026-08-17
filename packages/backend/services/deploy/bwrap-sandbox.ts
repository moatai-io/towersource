/**
 * bwrap (bubblewrap) Sandbox — lightweight process isolation for Claude CLI sessions.
 *
 * Wraps Claude CLI execution in a Linux namespace sandbox that:
 *   - Isolates filesystem: only allowed_path is writable, host /home is invisible
 *   - Isolates PIDs: sandbox processes can't see host processes
 *   - Passes through network (Claude API needs it)
 *   - Dies with parent process (no zombie orphans)
 *
 * Requires: apt install bubblewrap
 * Linux only. Disabled on other platforms via config.sandboxEnabled.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from '../../config.js';

type TowerRole = 'admin' | 'operator' | 'member' | 'viewer';

interface BwrapProfile {
  allowProc: boolean;       // mount /proc (process list visibility)
  networkEnabled: boolean;  // --unshare-net if false
}

const BWRAP_PROFILES: Record<TowerRole, BwrapProfile> = {
  admin:    { allowProc: true,  networkEnabled: true },
  operator: { allowProc: true,  networkEnabled: true },
  member:   { allowProc: false, networkEnabled: true },   // can't see host processes
  viewer:   { allowProc: false, networkEnabled: false },   // no network (Bash blocked by Damage Control anyway)
};

/**
 * Generate a bwrap wrapper script that the SDK can spawn as pathToClaudeCodeExecutable.
 *
 * The SDK spawns pathToClaudeCodeExecutable directly, so we give it a shell script
 * that wraps the real Claude CLI inside bwrap. SDK passes its args as "$@".
 *
 * Multi-account note (PR-4, 2026-05-09): pass `configDir` so the sandbox
 * mounts the *active* account's projects/ + session-env/ directories. When
 * sessions run under non-default accounts (e.g. ~/.claude-gmail/), failing
 * to mount that dir read-write would block the SDK child from writing its
 * turn jsonl. Default ~/.claude/ is always mounted as ro fallback.
 *
 * @param configDir Active CLAUDE_CONFIG_DIR (e.g. ~/.claude-gmail). undefined
 *                  = default ~/.claude/. Required so the caller can't silently
 *                  skip — pass `undefined` explicitly when the default is correct.
 */
export function createBwrapWrapper(
  allowedPath: string,
  role: TowerRole,
  configDir: string | undefined,
): string {
  const profile = BWRAP_PROFILES[role] || BWRAP_PROFILES.member;
  const claudeReal = fs.realpathSync(config.claudeExecutable);
  const claudeDir = path.dirname(claudeReal);
  const resolvedPath = path.resolve(allowedPath);
  const home = os.homedir();
  const activeConfigDir = configDir ?? path.join(home, '.claude');

  const lines: string[] = ['#!/bin/bash'];

  const bwrapArgs: string[] = [];

  // ── System binaries (read-only) ──
  for (const dir of ['/usr', '/bin', '/lib', '/lib64', '/sbin']) {
    if (fs.existsSync(dir)) {
      bwrapArgs.push(`--ro-bind ${dir} ${dir}`);
    }
  }

  // ── /etc: only what's needed ──
  for (const f of [
    '/etc/resolv.conf', '/etc/ssl', '/etc/passwd', '/etc/group',
    '/etc/hostname', '/etc/localtime', '/etc/alternatives',
  ]) {
    bwrapArgs.push(`--ro-bind-try ${f} ${f}`);
  }

  // ── Workspace (read/write) — keep host path so .jsonl session paths match ──
  bwrapArgs.push(`--bind ${resolvedPath} ${resolvedPath}`);

  // ── Claude CLI binary (read-only, at original host path) ──
  bwrapArgs.push(`--ro-bind ${claudeDir} ${claudeDir}`);

  // ── Claude config (keep real home path for session file compatibility) ──
  // .claude.json (top-level user config) lives in $HOME regardless of the
  // active configDir; SDK reads it for global preferences.
  const claudeJson = path.join(home, '.claude.json');
  if (fs.existsSync(claudeJson)) {
    bwrapArgs.push(`--ro-bind ${claudeJson} ${claudeJson}`);
  }
  // Mount the *active* configDir (skills, hooks, settings, credentials).
  if (fs.existsSync(activeConfigDir)) {
    bwrapArgs.push(`--ro-bind ${activeConfigDir} ${activeConfigDir}`);
  }
  // Default ~/.claude/ is also kept ro-bound when active dir is non-default,
  // because skill/agent assets are often symlinked from default → custom dir.
  const defaultClaudeDir = path.join(home, '.claude');
  if (defaultClaudeDir !== activeConfigDir && fs.existsSync(defaultClaudeDir)) {
    bwrapArgs.push(`--ro-bind ${defaultClaudeDir} ${defaultClaudeDir}`);
  }
  // Session data (write) — must come after ro-bind to override.
  // Mount the active account's projects/ for jsonl writes.
  const activeProjectsDir = path.join(activeConfigDir, 'projects');
  if (fs.existsSync(activeProjectsDir)) {
    bwrapArgs.push(`--bind ${activeProjectsDir} ${activeProjectsDir}`);
  }
  // Session env (write) — SDK creates session-env/{session-id}/ before Bash execution.
  const activeSessionEnvDir = path.join(activeConfigDir, 'session-env');
  if (!fs.existsSync(activeSessionEnvDir)) {
    fs.mkdirSync(activeSessionEnvDir, { recursive: true });
  }
  bwrapArgs.push(`--bind ${activeSessionEnvDir} ${activeSessionEnvDir}`);
  // ── Isolated temp ──
  bwrapArgs.push('--tmpfs /tmp', '--tmpfs /run', '--dev /dev');

  // ── /proc ──
  if (profile.allowProc) {
    bwrapArgs.push('--proc /proc');
  }

  // ── Namespace isolation ──
  bwrapArgs.push('--unshare-pid', '--unshare-uts', '--unshare-ipc');
  if (!profile.networkEnabled) {
    bwrapArgs.push('--unshare-net');
  }

  // ── Safety ──
  bwrapArgs.push('--die-with-parent', '--new-session', `--chdir ${resolvedPath}`);

  // ── Environment ──
  bwrapArgs.push(`--setenv HOME ${home}`);
  bwrapArgs.push('--unsetenv CLAUDECODE');

  // ── Assemble script ──
  lines.push(`exec bwrap \\`);
  for (const arg of bwrapArgs) {
    lines.push(`  ${arg} \\`);
  }
  lines.push(`  -- ${claudeReal} "$@"`);

  const script = lines.join('\n');

  // Write to a temp file
  const wrapperPath = path.join('/tmp', `tower-bwrap-${role}-${process.pid}.sh`);
  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });

  return wrapperPath;
}

/**
 * Check if bwrap is available on this system.
 */
export function isBwrapAvailable(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('bwrap --version', { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether sandbox should be used for this session.
 */
export function shouldUseSandbox(): boolean {
  return config.sandboxEnabled && process.platform === 'linux';
}
