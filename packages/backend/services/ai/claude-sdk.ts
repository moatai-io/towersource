import { isSessionSleeping, MAX_SLEEP_SECONDS, nextClaudeMessageWithSleep } from '../agent-sleep/sleep.js';
import { query, type SDKMessage, type Query, type Options, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { postToolUsePublishingTracker } from '../publishing/hook.js';
import { preToolUseConnectorGuard, BLOCKED_TOOL_NAMES } from '../security/connector-guard.js';
import { preToolUseSandboxPublicGate } from '../security/sandbox-public-gate.js';
import { makePostToolUseProvenance } from '../audit/hook.js';
import { makePreToolUseWorkspaceGuard } from '../workspace-guard/hook.js';
import { makePostToolUseFileEditLog } from '../workspace/file-edit-log.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from '../../config.js';
import { createBwrapWrapper, shouldUseSandbox } from '../deploy/bwrap-sandbox.js';
import { findJsonlFile } from '../workspace/jsonl-utils.js';
import {
  getSkillsForSession,
  hasProjectManagedSkillManifestForContext,
} from '../skill/skill-registry.js';

// CRITICAL: Remove CLAUDECODE env var to prevent SDK conflicts
delete process.env.CLAUDECODE;

// Clean up orphaned Claude processes from previous backend runs.
// When tsx watch restarts the backend, SDK-spawned CLI processes lose their
// parent and become orphans (ppid=1, tty=?).
//
// Strategy: DON'T kill immediately. Orphans may be mid-task for minutes.
// Instead, poll every 60s and only kill orphans that have been idle (low CPU)
// for at least one check cycle. This lets long-running tasks finish and flush
// their .jsonl files, so resume always works.
//
// Session IDs are preserved in DB — user's next message resumes from .jsonl.
const ORPHAN_CHECK_INTERVAL = 60_000; // check every 60s
const ORPHAN_CPU_IDLE_THRESHOLD = 1.0; // below 1% CPU = idle
let orphanCheckTimer: ReturnType<typeof setInterval> | null = null;
const idleOrphans = new Set<number>(); // PIDs that were idle on last check

// Restart-loop guard: track when the server started so we can detect rapid restarts
const SERVER_START_TIME = Date.now();
const MIN_UPTIME_FOR_INTERRUPT_FILE_MS = 30_000; // 30s — if uptime < this, don't write interrupted file

export function cleanupOrphanedSdkProcesses() {
  // Don't stack multiple intervals
  if (orphanCheckTimer) return;

  console.log('[sdk] Starting orphan monitor (check every 60s, kill only idle orphans)');
  orphanCheckTimer = setInterval(() => {
    try {
      // Find orphans with their CPU usage
      const result = execSync(
        `ps -eo pid,ppid,tty,pcpu,args | awk '$2==1 && $3=="?" && /claude.*(--dangerously-skip-permissions|--permission-mode)/ {print $1, $4}'`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();

      if (!result) {
        idleOrphans.clear();
        return;
      }

      const entries = result.split('\n').filter(Boolean).map(line => {
        const [pid, cpu] = line.trim().split(/\s+/);
        return { pid: Number(pid), cpu: parseFloat(cpu) || 0 };
      });

      for (const { pid, cpu } of entries) {
        if (cpu < ORPHAN_CPU_IDLE_THRESHOLD) {
          if (idleOrphans.has(pid)) {
            // Idle for 2 consecutive checks → safe to kill
            try {
              process.kill(pid, 'SIGTERM');
              console.log(`[sdk] SIGTERM idle orphan PID=${pid} (CPU=${cpu}%, idle for 2 checks)`);
            } catch { /* already dead */ }
            idleOrphans.delete(pid);
          } else {
            // First time seeing it idle — mark it, kill on next check
            idleOrphans.add(pid);
          }
        } else {
          // Still working — remove from idle set, let it run
          idleOrphans.delete(pid);
        }
      }

      // Clean up PIDs that disappeared
      for (const pid of idleOrphans) {
        if (!entries.some(e => e.pid === pid)) {
          idleOrphans.delete(pid);
        }
      }
    } catch { /* ps/awk not available */ }
  }, ORPHAN_CHECK_INTERVAL);

  // Don't prevent Node from exiting
  orphanCheckTimer.unref();
}

export function stopOrphanMonitor() {
  if (orphanCheckTimer) {
    clearInterval(orphanCheckTimer);
    orphanCheckTimer = null;
    idleOrphans.clear();
  }
}

// Cleanup deferred — called conditionally from index.ts after task recovery

// Graceful shutdown: mark sessions as not running but do NOT abort CLI processes.
// Let them become orphans — the next startup's cleanupOrphanedSdkProcesses()
// will SIGTERM them gracefully, giving them time to flush session files.
// Also marks streaming sessions as "interrupted" in DB so frontend can auto-resume.
export function gracefulShutdown(signal: string) {
  const interruptedSessions: Array<{ id: string; claudeSessionId?: string }> = [];
  for (const session of activeSessions.values()) {
    if (session.isRunning) {
      session.isRunning = false;
      interruptedSessions.push({ id: session.id, claudeSessionId: session.claudeSessionId });
    }
  }
  if (interruptedSessions.length > 0) {
    const uptimeMs = Date.now() - SERVER_START_TIME;
    if (uptimeMs < MIN_UPTIME_FOR_INTERRUPT_FILE_MS) {
      // Restart-loop guard: server was up for less than 30s → likely a restart loop.
      // Do NOT write the interrupted file — break the cycle.
      console.warn(`[sdk] ${signal}: Skipping interrupted-sessions file (uptime ${Math.round(uptimeMs / 1000)}s < ${MIN_UPTIME_FOR_INTERRUPT_FILE_MS / 1000}s — restart loop guard)`);
      return;
    }
    console.log(`[sdk] ${signal}: ${interruptedSessions.length} CLI process(es) will be cleaned up on next startup`);
    // Write interrupted session details to a temp file for next startup to read.
    // Can't use async DB calls in shutdown handler (process exits too fast).
    //
    // Atomic write: temp file + renameSync. Plain writeFileSync truncates first,
    // so if the process is killed (SIGKILL) mid-write the next startup reads an
    // empty/partial file → JSON.parse throws → catch returns [] → sessions
    // silently lost. Observed 2026-05-17 at 11:59:56 SIGINT (4 sessions reported
    // here but next startup logged 0 recovered).
    // See: workspace/decisions/2026-05-17-restart-interrupted-session-recovery-fix.md
    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const finalPath = path.join(dataDir, 'interrupted-sessions.json');
      const tmpPath = `${finalPath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ sessions: interruptedSessions, at: new Date().toISOString() }),
      );
      fs.renameSync(tmpPath, finalPath);
    } catch (err: any) {
      console.error(`[sdk] Failed to write interrupted sessions file:`, err.message);
    }
  }
}

export interface ClaudeSession {
  id: string;
  claudeSessionId?: string;
  /** Last known good claudeSessionId whose .jsonl was confirmed to exist (for abort fallback) */
  prevClaudeSessionId?: string;
  abortController: AbortController;
  query?: Query;
  isRunning: boolean;
}

const activeSessions = new Map<string, ClaudeSession>();

// ── Global resume lock ──────────────────────────────────────────────
// Prevents two executeQuery calls from concurrently resuming the same
// Claude session file (.jsonl). Room-level locks in ai-quick-reply.ts
// only serialize within one room — different rooms sharing a session ID
// (rare but possible) would race without this.
const resumeLocks = new Map<string, Promise<void>>();

async function withResumeLock<T>(resumeId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!resumeId) return fn();

  const prev = resumeLocks.get(resumeId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  resumeLocks.set(resumeId, next);

  await prev;

  try {
    return await fn();
  } finally {
    resolve!();
    if (resumeLocks.get(resumeId) === next) {
      resumeLocks.delete(resumeId);
    }
  }
}

// Session file backup directory — protects against external .jsonl deletion
const SESSION_BACKUP_DIR = path.join(process.cwd(), 'data', 'session-backups');

/** Get the SDK .jsonl file path for a given claudeSessionId and cwd */
function getJsonlPath(claudeSessionId: string, cwd: string, configDir?: string): string {
  const encodedCwd = cwd.replace(/\//g, '-');
  const base = configDir || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', encodedCwd, `${claudeSessionId}.jsonl`);
}

/** Get the backup path for a .jsonl file */
function getBackupPath(claudeSessionId: string): string {
  return path.join(SESSION_BACKUP_DIR, `${claudeSessionId}.jsonl`);
}

/**
 * Back up a .jsonl session file after a successful turn.
 * If the SDK or CLI later deletes the original, we can restore it.
 */
export function backupSessionFile(claudeSessionId: string, cwd: string, configDir?: string): boolean {
  const jsonlPath = findJsonlFile(claudeSessionId, cwd, configDir) || getJsonlPath(claudeSessionId, cwd, configDir);
  if (!fs.existsSync(jsonlPath)) return false;

  try {
    if (!fs.existsSync(SESSION_BACKUP_DIR)) {
      fs.mkdirSync(SESSION_BACKUP_DIR, { recursive: true });
    }
    fs.copyFileSync(jsonlPath, getBackupPath(claudeSessionId));
    return true;
  } catch (err: any) {
    console.warn(`[sdk] backup failed for ${claudeSessionId.slice(0, 12)}: ${err.message}`);
    return false;
  }
}

/**
 * Restore a .jsonl session file from backup if the original is missing.
 * Returns true if restored, false if no backup available.
 */
function restoreSessionFile(claudeSessionId: string, cwd: string, configDir?: string): boolean {
  const jsonlPath = getJsonlPath(claudeSessionId, cwd, configDir);
  if (fs.existsSync(jsonlPath)) return true; // original exists, no need

  const backupPath = getBackupPath(claudeSessionId);
  if (!fs.existsSync(backupPath)) return false; // no backup

  try {
    // Ensure target directory exists
    const dir = path.dirname(jsonlPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.copyFileSync(backupPath, jsonlPath);
    console.log(`[sdk] restored .jsonl from backup: ${claudeSessionId.slice(0, 12)}`);
    return true;
  } catch (err: any) {
    console.warn(`[sdk] restore from backup failed for ${claudeSessionId.slice(0, 12)}: ${err.message}`);
    return false;
  }
}

/**
 * Repair a .jsonl session file by removing corrupted trailing lines.
 * When a CLI process is killed mid-write, the last line may be truncated JSON.
 * The SDK refuses to resume from a corrupted file (exit code 1).
 * Fix: read backwards, remove lines that aren't valid JSON, keep the rest.
 */
function repairSessionFile(claudeSessionId: string, cwd: string, configDir?: string): boolean {
  const jsonlPath = getJsonlPath(claudeSessionId, cwd, configDir);

  if (!fs.existsSync(jsonlPath)) return false;

  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n');

    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    if (lines.length === 0) return false;

    // Check last lines for valid JSON, remove corrupted ones
    let removed = 0;
    while (lines.length > 0) {
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine === '') { lines.pop(); continue; }
      try {
        JSON.parse(lastLine);
        break; // valid JSON — stop
      } catch {
        lines.pop();
        removed++;
      }
    }

    if (removed > 0 && lines.length > 0) {
      fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
      console.log(`[sdk] Repaired ${jsonlPath}: removed ${removed} corrupted line(s), ${lines.length} lines remain`);
      return true;
    }
  } catch (err: any) {
    console.warn(`[sdk] Failed to repair session file: ${err.message}`);
  }
  return false;
}

export function getActiveSessionCount(): number {
  let count = 0;
  for (const session of activeSessions.values()) {
    if (session.isRunning) count++;
  }
  return count;
}

/**
 * `executeQuery` options.
 *
 * **`configDir` is required** (PR-3, 2026-05-09). The caller must explicitly
 * decide which Claude account credential directory the SDK spawns under, even
 * if that decision is "none, use the default account" (`undefined`). Making it
 * optional led to silent skips on non-default-account paths (channel AI, task
 * runner) — every such skip rotated to ~/.claude/ regardless of the project's
 * configured account, leaking jsonl files into the wrong directory.
 *
 * Pass `undefined` only for legitimate default-account use (single-account
 * installs, or contexts where credential rotation genuinely doesn't matter).
 * For session-bound work, pass `sessionRow.config_dir ?? undefined`.
 *
 * See: workspace/decisions/2026-05-09-multi-account-configdir-audit.md
 */
export interface ExecuteQueryOptions {
  cwd?: string;
  resumeSessionId?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  canUseTool?: CanUseTool;
  /**
   * System prompt — accepts `string` (legacy) or `string[]` with
   * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` as a standalone element to enable
   * cross-session prompt caching of the static prefix. See SDK docs and
   * workspace/decisions/2026-05-14-sdk-credit-economy.md.
   */
  systemPrompt?: string | string[];
  userRole?: string;
  /** Claude account credential directory (CLAUDE_CONFIG_DIR). Required —
   *  pass `undefined` explicitly to use the default account. */
  configDir: string | undefined;
  maxTurns?: number;   // limit SDK turns (default: unlimited)
  userId?: number;     // for TOWER_API_TOKEN env injection (Tier 1 capture)
  username?: string;   // for TOWER_API_TOKEN claims
  /**
   * In-process MCP servers (e.g. sandbox). Caller passes already-instantiated
   * server configs from createSdkMcpServer(). Pass-through to SDK query().
   * Decision: workspace/decisions/2026-04-24-execution-sandbox-scope.md (D6)
   */
  mcpServers?: Record<string, any>;
}

export async function* executeQuery(
  sessionId: string,
  prompt: string,
  options: ExecuteQueryOptions,
): AsyncGenerator<SDKMessage> {
  // Abort any existing query for this session
  const existing = activeSessions.get(sessionId);
  if (existing?.isRunning) {
    console.log(`[sdk] executeQuery aborting EXISTING running session=${sessionId}`);
    existing.abortController.abort();
    // Wait briefly for the SDK process to flush its .jsonl before we proceed.
    // Without this, the process may be mid-write when we try to read the file,
    // leading to "No conversation found" or corrupt session errors.
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  // Preserve previous claudeSessionId for abort fallback
  const prevClaudeSessionId = existing?.prevClaudeSessionId || existing?.claudeSessionId;

  const abortController = new AbortController();
  const session: ClaudeSession = {
    id: sessionId,
    claudeSessionId: options.resumeSessionId,
    prevClaudeSessionId,
    abortController,
    isRunning: true,
  };
  activeSessions.set(sessionId, session);

  const useSandbox = shouldUseSandbox();
  const sandboxRole = (options.userRole || 'member') as 'admin' | 'operator' | 'member' | 'viewer';
  const effectiveCwd = options.cwd || config.defaultCwd;
  const projectManagedSkillsReady = await hasProjectManagedSkillManifestForContext(null, effectiveCwd).catch(() => false);
  const towerActiveSkills = await getSkillsForSession(options.userId, null, options.username || null, effectiveCwd).catch(() => []);
  const towerActiveSkillNames = towerActiveSkills.map((s: any) => s.name).filter((name: unknown): name is string => typeof name === 'string');

  if (useSandbox) {
    console.log(`[sdk] bwrap sandbox enabled for session=${sessionId} role=${sandboxRole} cwd=${effectiveCwd}`);
  }

  // Sandbox: generate a wrapper script that invokes bwrap around Claude CLI.
  // PR-4 (2026-05-09): forward options.configDir so the bwrap mount mounts the
  // *active* account's projects/ + session-env/ (e.g. ~/.claude-gmail/) — not
  // just default ~/.claude/. Without this, sandbox + non-default-account
  // sessions couldn't write turn jsonl.
  const wrapperPath = useSandbox
    ? createBwrapWrapper(effectiveCwd, sandboxRole, options.configDir)
    : undefined;

  // Build env injection — combines:
  //   CLAUDE_CODE_DISABLE_AUTO_MEMORY (always — multi-tenant isolation, see below)
  //   CLAUDE_CONFIG_DIR (credential rotation, optional)
  //   TOWER_SESSION_ID (ALWAYS — audit trailer 의 핵심)
  //
  // CLAUDE_CODE_DISABLE_AUTO_MEMORY=true is now ALWAYS injected.
  // SDK natively exposes cwd-memory via the init system message's `memory_paths.auto`
  // field, which bypasses Tower's project boundary — a cross-project leak vector
  // confirmed on 2026-05-07 (demo-server's user_role.md leaked from /home/tower/workspace
  // to a new project under projects/project-3b46ff2e). The 4 native memory tools
  // (memory, memory_recall, memory_saved, memory_survey) are not currently used
  // by Tower, so disabling has no functional cost.
  // 결정: workspace/decisions/2026-05-07-isolation-hypotheses-broken.md
  //
  // ⚠️ TOWER_SESSION_ID 회귀 fix (2026-05-15):
  // 2026-05-09 PM 폐기 전엔 TOWER_SESSION_ID 가 AI_PM_ENABLED 가드 안에 묶여 있었음.
  // 폐기 시 가드 안에 그대로 남겨두면서 *모든 commit 의 Tower-Session trailer*
  // 가 빈 값으로 박힘 (audit grep 으로 세션별 추적 불가능 — git log -20 기준 ~80% 빈 값).
  // 시스템 프롬프트가 "모든 commit 에 필수" 라 약속한 audit 핵심이 깨진 상태였음.
  // 분리: TOWER_SESSION_ID 는 PM 과 무관한 독립 기능이므로 가드 밖으로 이동 → 항상 inject.
  // 결정문서: workspace/decisions/2026-05-15-tower-session-trailer-regression.md (작성 예정)
  const injectedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: 'true',
    TOWER_SESSION_ID: sessionId,
    // ENABLE_PROMPT_CACHING_1H — internal SDK gate (cli.js L8319 `o85` fn).
    // 명시 env 가 true 면 SDK 가 cache_control 에 `ttl:"1h"` 자동 박음.
    // 우리 admin VM 실측 결과 비용의 51% 가 cache_create (5분 TTL 만료 후 재캐시).
    // 1h TTL 로 만료 빈도 12배 감소 — write 단가 1.6배 비싸지만 ROI 큼.
    //
    // 또한: Anthropic 이 2026-03-06 에 기본 TTL 을 1h → 5m 으로 silent 강등
    // (GitHub anthropics/claude-code #46829, HN/DEV 다수 보고). 이 env 박는 건
    // 사실상 *회귀 복구*. 명시 안 박으면 Statsig dynamic config 의존하므로 위험.
    //
    // Kill switch: FORCE_PROMPT_CACHING_5M=1 박으면 무시됨 (롤백 용).
    // 근거: workspace/decisions/2026-05-14-sdk-credit-economy.md (TTL 추가 예정)
    ENABLE_PROMPT_CACHING_1H: process.env.ENABLE_PROMPT_CACHING_1H ?? '1',
  };
  if (options.configDir) injectedEnv.CLAUDE_CONFIG_DIR = options.configDir;
  // SDK in-process MCP lacks a per-server timeout. Keep Tower's normal idle watchdog
  // for other tools, while raising SDK's hard tool cap enough for bounded sleep.
  if (options.mcpServers?.wait) {
    injectedEnv.MCP_TOOL_TIMEOUT = String(Math.max(Number(injectedEnv.MCP_TOOL_TIMEOUT) || 0, (MAX_SLEEP_SECONDS + 60) * 1000));
  }

  const queryOptions: Options = {
    abortController,
    pathToClaudeCodeExecutable: wrapperPath || config.claudeExecutable,
    cwd: effectiveCwd,
    permissionMode: options.permissionMode || config.permissionMode,
    settingSources: projectManagedSkillsReady ? ['project'] : ['user', 'project'],
    // Inline Settings — Trim CC's built-in git/PR template (~2KB) from the
    // system prompt and suppress its default "Co-Authored-By: Claude ..."
    // attribution. We replace both with a compact Tower section in
    // system-prompt.ts (SECTION_GIT_TOWER) — Korean commit messages OK,
    // `Tower-Session: $TOWER_SESSION_ID` trailer (audit trail), and references
    // to /commit-session + /finish-branch skills.
    // Decision: workspace/decisions/2026-05-09-cc-builtin-instruction-trimming.md
    settings: {
      includeGitInstructions: false,
      attribution: { commit: '', pr: '' },
      ...(projectManagedSkillsReady ? { strictPluginOnlyCustomization: ['skills' as const] } : {}),
      // 컨텍스트 windowing — SDK 가 누적 input 이 이 값 가까이 가면 server-side
      // 자동 압축(요약) 실행. 기본값은 SDK 미공개 (실측 결과 1M 까지 갔으므로
      // 매우 큰 듯). 500K 로 박아서 *평균 컨텍스트 크기를 자연 감소*.
      //
      // 효과 (1주일 실측 후 검증):
      //   - demo-org 의 turn 중 24.9% 가 800K+ (74.2% of tokens) — 이 영역이
      //     500K 직전 자동 압축됨 → 누적 토큰 대폭 감소
      //   - admin 의 26.2% 가 500K+ — 동일
      //   - 1M context 능력은 유지 (cap 이 아니라 *압축 임계값*)
      //
      // 트레이드오프: compaction 자체가 LLM 호출 (요약 작성 비용) + 일부 정보
      // 압축 손실. 500K 가 sweet spot 이면 좋고, 너무 자주 발동하면 더 올림.
      //
      // 근거: workspace/decisions/2026-05-14-sdk-credit-economy.md (2026-05-15 정정)
      autoCompactWindow: 500_000,
    },
    env: injectedEnv,  // always — at minimum carries CLAUDE_CODE_DISABLE_AUTO_MEMORY=true
    // disallowedTools — `mcp__claude_ai_*` connector + meta resource tools.
    // Removes schema from the model's context entirely (token savings + the AI
    // never sees these tools as an option). Catch-all regex hook below picks
    // up any new connector that Anthropic adds later (no manual list update
    // needed for the regex to match). Decision:
    // workspace/decisions/2026-05-11-mcp-multi-tenant-policy.md
    disallowedTools: BLOCKED_TOOL_NAMES,
    // Hooks — inline here, NOT in ~/.claude/hooks/*.mjs, so they work across
    // multi-config-home (.claude / .claude-gmail) and self-hosted servers without
    // separate sync. See docs/tower-guide/ai-execution-paths.md §3-2 and
    // workspace/decisions/2026-05-09-tower-hooks-via-sdk-options.md.
    hooks: {
      // PreToolUse —
      //   1. claude.ai connector 원천 차단 (multi-tenant 격리). Catch-all
      //      regex picks up tools added later by Anthropic.
      //      Decision: workspace/decisions/2026-05-11-mcp-multi-tenant-policy.md
      //   2. workspace root mkdir guard (ghost project 방지 + ALLOWED_ROOTS).
      //      Decisions: 2026-05-01-workspace-root-guard.md,
      //                 2026-05-04-projects-mkdir-policy.md,
      //                 2026-05-11-hook-parity-self-hosted-servers.md
      PreToolUse: [
        { hooks: [preToolUseConnectorGuard] },
        // Sandbox public-visibility gate — denies AI-driven visibility="public"
        // calls. Forces 2-step promotion: AI starts as unlisted, user manually
        // upgrades. Decision:
        // workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
        { matcher: 'mcp__sandbox__tool_start|mcp__sandbox__tool_update_visibility', hooks: [preToolUseSandboxPublicGate] },
        // Factory-bound to this call's Tower session id — backend parent
        // process can't see TOWER_SESSION_ID env (that's injected into the SDK
        // child process). Closure preserves it for the audit log.
        { matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [makePreToolUseWorkspaceGuard(sessionId)] },
      ],
      // PostToolUse —
      //   1. publishing tracker (auto-register sites in manifest).
      //      Decision: workspace/decisions/2026-05-09-tower-hooks-via-sdk-options.md
      //   2. provenance audit (~/workspace/.audit/provenance.jsonl) — feeds
      //      /commit-session and multi-session safety.
      //      Decisions: 2026-05-03-multi-session-safety.md,
      //                 2026-05-11-hook-parity-self-hosted-servers.md
      PostToolUse: [
        { matcher: 'Write|Edit|NotebookEdit', hooks: [postToolUsePublishingTracker] },
        // Factory-bound — see PreToolUse comment. Without this, /commit-session
        // grep by $TOWER_SESSION_ID returns 0 matches (entries written but
        // missing the towerSessionId key).
        { matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [makePostToolUseProvenance(sessionId, { userId: options.userId, username: options.username })] },
        // Session-backlinks log — PG-native source of truth for "관련 세션".
        // Replaces the legacy ~/.claude/memory.db read path; Claude sessions now
        // record file edits directly into session_file_edits, the same table Pi
        // already uses. See: workspace/decisions/2026-05-20-session-file-edits-pg-unification.md
        { matcher: 'Write|Edit|NotebookEdit', hooks: [makePostToolUseFileEditLog(sessionId)] },
      ],
    },
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers as any } : {}),
  };

  if (options.resumeSessionId) {
    // Global resume lock: prevents two concurrent calls from racing on the same .jsonl file.
    // Room-level locks in ai-quick-reply.ts only serialize within one room — this catches
    // cross-room or cross-session races on the same underlying Claude session.
    await withResumeLock(options.resumeSessionId, async () => {
      const resumeCwd = queryOptions.cwd || config.defaultCwd;
      const cfgDir = options.configDir;

      // Try to find .jsonl for the requested claudeSessionId
      let resolvedResumeId = options.resumeSessionId!;
      let jsonlPath = findJsonlFile(resolvedResumeId, resumeCwd, cfgDir);

      // If not found anywhere, try restoring from our backup to the expected path
      if (!jsonlPath) {
        restoreSessionFile(resolvedResumeId, resumeCwd, cfgDir);
        const expectedPath = getJsonlPath(resolvedResumeId, resumeCwd, cfgDir);
        if (fs.existsSync(expectedPath)) jsonlPath = expectedPath;
      }

      // Fallback: if current ID's .jsonl missing (e.g. abort killed process before flush),
      // try the previous known-good claudeSessionId whose .jsonl should still exist
      if (!jsonlPath && prevClaudeSessionId && prevClaudeSessionId !== resolvedResumeId) {
        console.log(`[sdk] resume fallback: session=${sessionId.slice(0,8)} current=${resolvedResumeId.slice(0,12)} → prev=${prevClaudeSessionId.slice(0,12)}`);
        jsonlPath = findJsonlFile(prevClaudeSessionId, resumeCwd, cfgDir);
        if (!jsonlPath) {
          restoreSessionFile(prevClaudeSessionId, resumeCwd, cfgDir);
          const expectedPath = getJsonlPath(prevClaudeSessionId, resumeCwd, cfgDir);
          if (fs.existsSync(expectedPath)) jsonlPath = expectedPath;
        }
        if (jsonlPath) {
          resolvedResumeId = prevClaudeSessionId;
          session.claudeSessionId = prevClaudeSessionId;
        }
      }

      if (jsonlPath) {
        // Cross-configDir recovery (legacy account-rotation path).
        //
        // PR-1 + PR-3 (2026-05-09) make this rare: sessions.config_dir pins
        // the configDir at create time, and all executeQuery callers now
        // forward it explicitly, so the jsonl naturally lands in expectedPath.
        // We KEEP the recovery copy because two scenarios still produce a
        // jsonl in a different configDir than `cfgDir` argues for:
        //   1. Old sessions created before PR-1 backfill where the project's
        //      account was later reassigned — config_dir on the row matches
        //      the *new* account, but the jsonl is still under the old one.
        //   2. Manual ssh ops or scripts that copy jsonl across configDirs.
        // In both, findJsonlFile's default-account fallback (jsonl-utils.ts)
        // discovers the file outside cfgDir, and this block copies it to
        // expectedPath so the SDK child process can read it.
        if (cfgDir) {
          const expectedPath = getJsonlPath(resolvedResumeId, resumeCwd, cfgDir);
          if (jsonlPath !== expectedPath) {
            // Copy if target doesn't exist, or source is newer/larger (account was switched back)
            try {
              const sourceSize = fs.statSync(jsonlPath).size;
              const targetExists = fs.existsSync(expectedPath);
              const targetSize = targetExists ? fs.statSync(expectedPath).size : 0;
              if (!targetExists || sourceSize > targetSize) {
                const dir = path.dirname(expectedPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.copyFileSync(jsonlPath, expectedPath);
                console.log(`[sdk] cross-cfgDir recovery copy: ${resolvedResumeId.slice(0, 12)} (${sourceSize} > ${targetSize}) → ${path.basename(path.dirname(expectedPath))}`);
              }
            } catch (err: any) {
              console.warn(`[sdk] cross-cfgDir recovery copy failed: ${err.message}`);
            }
          }
        }
        // Repair .jsonl before resume — removes corrupted trailing lines from killed processes
        repairSessionFile(resolvedResumeId, resumeCwd, cfgDir);
        queryOptions.resume = resolvedResumeId;
        console.log(`[sdk] resume attempt: session=${sessionId.slice(0,8)} claudeSid=${resolvedResumeId.slice(0,12)} jsonl=${path.basename(path.dirname(jsonlPath))}`);
      } else {
        // Don't silently start a new session — that's worse than failing.
        // The user thinks they're continuing a conversation, but the AI has no context.
        console.error(`[sdk] resume FAILED (no file, no backup): session=${sessionId.slice(0,8)} claudeSid=${options.resumeSessionId!.slice(0,12)} cwd=${queryOptions.cwd}`);
        throw new Error(
          `이전 대화를 이어갈 수 없습니다 (세션 파일을 찾을 수 없음). 새 세션에서 시작해주세요.`
        );
      }
    });
  }

  // Helper: run query and yield messages
  async function* runQuery(opts: Options): AsyncGenerator<SDKMessage> {
    const response = query({ prompt, options: opts });
    session.query = response;
    let resumeConfirmed = false;

    // Claude Agent SDK can occasionally stall after a tool_result: the child
    // process remains alive, Tower sees the session as streaming forever, and
    // the user only sees a few initial syllables. Pi has its own watchdog; this
    // is the Claude-side equivalent. Defaults are deliberately conservative:
    // long thinking/tool turns may be valid, but *after* a tool_result the next
    // assistant/system/result event should arrive quickly.
    const STREAM_IDLE_MS = Number(process.env.CLAUDE_STREAM_IDLE_MS) || 10 * 60_000;
    const AFTER_TOOL_IDLE_MS = Number(process.env.CLAUDE_AFTER_TOOL_IDLE_MS) || 2 * 60_000;
    let lastWasToolResult = false;

    const iterator = response[Symbol.asyncIterator]();
    try {
      while (true) {
        const timeoutMs: number = lastWasToolResult ? AFTER_TOOL_IDLE_MS : STREAM_IDLE_MS;
        const phase: string = lastWasToolResult ? 'after tool_result' : 'stream idle';
        const next: IteratorResult<SDKMessage> = await nextClaudeMessageWithSleep(iterator.next(), timeoutMs, () => isSessionSleeping(sessionId), phase);
        if (next.done) break;
        const message: SDKMessage = next.value;

        if (message.type === 'system' && message.subtype === 'init') {
          // Promote current claudeSessionId to prev before overwriting
          if (session.claudeSessionId && session.claudeSessionId !== message.session_id) {
            session.prevClaudeSessionId = session.claudeSessionId;
          }
          session.claudeSessionId = message.session_id;
          if (projectManagedSkillsReady) {
            const sdkSkills = Array.isArray((message as any).skills) ? (message as any).skills : [];
            const leaked = sdkSkills.filter((name: unknown) => typeof name === 'string' && !towerActiveSkillNames.includes(name));
            if (leaked.length > 0) {
              console.warn(`[sdk] skill init mismatch: resolutionSource=project-manifest blockedReason=native_sdk_extra_skills leaked=${leaked.join(',')} allowed=${towerActiveSkillNames.join(',') || 'none'}`);
            } else if (process.env.TOWER_DEBUG_SKILLS === '1' || process.env.TOWER_DEBUG_SKILLS === 'true') {
              console.log(`[sdk] skill init ok: resolutionSource=project-manifest skills=${sdkSkills.join(',') || 'none'}`);
            }
          }
          if (opts.resume && !resumeConfirmed) {
            console.log(`[sdk] resume succeeded: session=${sessionId.slice(0,8)} claudeSid=${message.session_id?.slice(0,12)}`);
            resumeConfirmed = true;
          }
        }
        if ('session_id' in message && message.session_id) {
          if (session.claudeSessionId && session.claudeSessionId !== message.session_id) {
            session.prevClaudeSessionId = session.claudeSessionId;
          }
          session.claudeSessionId = message.session_id;
        }

        const content = (message as any).message?.content;
        lastWasToolResult = (message as any).type === 'user'
          && Array.isArray(content)
          && content.some((block: any) => block?.type === 'tool_result');

        yield message;
      }
    } catch (err: any) {
      if (/Claude stream watchdog timeout/.test(err?.message || '')) {
        console.warn(`[sdk] ${err.message}; aborting session=${sessionId.slice(0, 8)}`);
        abortController.abort();
      }
      throw err;
    } finally {
      try { await iterator.return?.(); } catch {}
    }
  }

  // Helper: check if an error is an abort (SDK may throw Error with message, not AbortError)
  const isAbortError = (err: any) =>
    err.name === 'AbortError' || /aborted by user|abort/i.test(err.message || '');

  try {
    yield* runQuery(queryOptions);
  } catch (error: any) {
    if (isAbortError(error)) {
      return;
    }
    // Resume failed (exit code 1, stale session) → retry without resume
    if (queryOptions.resume && /exited with code|ENOENT|session.*not found|unexpected token|invalid json|parse error|corrupt/i.test(error.message || '')) {
      console.warn(`[sdk] resume failed for session=${sessionId}, retrying fresh: ${error.message}`);
      // Yield a synthetic message so callers can notify the user
      yield {
        type: 'system',
        subtype: 'resume_failed',
        session_id: sessionId,
        message: 'Previous conversation context could not be restored. Starting fresh.',
      } as any;
      const freshOptions = { ...queryOptions };
      delete freshOptions.resume;
      session.claudeSessionId = undefined;
      try {
        yield* runQuery(freshOptions);
      } catch (retryError: any) {
        if (isAbortError(retryError)) return;
        throw retryError;
      }
    } else {
      console.error(`[sdk] query error (unmatched for resume): ${error.message}`);
      throw error;
    }
  } finally {
    session.isRunning = false;
    // Auto-cleanup after 5 minutes to prevent memory leak
    setTimeout(() => {
      const current = activeSessions.get(sessionId);
      if (current === session && !current.isRunning) {
        activeSessions.delete(sessionId);
      }
    }, 5 * 60 * 1000);
  }
}

export function abortSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (session?.isRunning) {
    console.log(`[sdk] abortSession session=${sessionId}`, new Error().stack?.split('\n').slice(1, 4).join(' ← '));
    session.abortController.abort();
    session.isRunning = false;
    return true;
  }
  return false;
}

export function getSession(sessionId: string): ClaudeSession | undefined {
  return activeSessions.get(sessionId);
}

export function getRunningSessionIds(): string[] {
  const ids: string[] = [];
  for (const [id, session] of activeSessions) {
    if (session.isRunning) ids.push(id);
  }
  return ids;
}

export function getClaudeSessionId(sessionId: string): string | undefined {
  return activeSessions.get(sessionId)?.claudeSessionId;
}

export interface InterruptedSession {
  id: string;
  claudeSessionId?: string;
  /** User message that carries metadata.agent_turn checkpoint. */
  userMessageId?: string;
  /** Diagnostic source, e.g. shutdown-file or db-agent-turn-checkpoint. */
  recoverySource?: string;
}

/**
 * Read and consume the interrupted-sessions.json file written during graceful shutdown.
 * Returns session details that were streaming when the backend last shut down.
 */
export function consumeInterruptedSessions(): InterruptedSession[] {
  const filePath = path.join(process.cwd(), 'data', 'interrupted-sessions.json');
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Delete the file so it's only consumed once
    fs.unlinkSync(filePath);
    const raw: Array<string | InterruptedSession> = data.sessions || [];
    // Backward compat: old format stored plain string IDs
    const sessions: InterruptedSession[] = raw.map(s =>
      typeof s === 'string' ? { id: s } : s
    );
    if (sessions.length > 0) {
      console.log(`[sdk] Recovered ${sessions.length} interrupted session(s) from previous shutdown`);
    }
    return sessions;
  } catch {
    return [];
  }
}

export function cleanupSession(sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (session?.isRunning) {
    console.log(`[sdk] cleanupSession (running!) session=${sessionId}`, new Error().stack?.split('\n').slice(1, 4).join(' ← '));
    session.abortController.abort();
  }
  activeSessions.delete(sessionId);
}

/** The in-process sleep MCP server uses the same cancellation boundary as the SDK run. */
export function getSessionAbortSignal(sessionId: string): AbortSignal | undefined {
  return activeSessions.get(sessionId)?.abortController.signal;
}
