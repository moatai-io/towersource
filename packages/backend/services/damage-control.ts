/**
 * Damage Control — role-based tool & Bash command restrictions.
 *
 * 5-tier role system (2026-08-27):
 *   admin    → Tower 보안·조직·인증·비밀정보를 포함한 unrestricted 관리.
 *   operator → 전체 서버 관찰·진단·트러블슈팅·복구. DENY_SYSTEM 및 Secret Guard 적용.
 *   member   → 일반 직원. DENY_SYSTEM + DENY_SYSPACKAGE bash patterns
 *   guest            → 외부 파트너. member 와 도구 권한 동일 (DENY_SYSTEM + DENY_SYSPACKAGE).
 *                      차이는 *어떤 프로젝트에서 가능한지* 만 (auto-member ❌, project 생성 ❌).
 *   viewer           → 감사·관전. whitelist-only tools (read-only)
 */

import path from 'path';

export type TowerRole = 'admin' | 'operator' | 'member' | 'guest' | 'viewer';

export const VALID_ROLES = new Set<string>([
  'admin', 'operator', 'member', 'guest', 'viewer',
]);

/** Workspace-wide operational roles. Secret reveal and admin-only settings remain admin-only. */
export function isPrivilegedTowerRole(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'operator';
}

// ─── Bash deny patterns ─────────────────────────────────────────────────────

/** System-destructive patterns (operator + member + guest) */
const DENY_SYSTEM: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /rm\s+(-[^\s]*)?r[^\s]*f[^\s]*\s+(\/(\s|$)|~|\$HOME)/,   label: 'recursive delete on root/home' },
  { pattern: /\bsudo\b/,                                               label: 'privilege escalation (sudo)' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash|zsh)/,                           label: 'remote script execution (curl|sh)' },
  { pattern: /\bwget\b.*\|\s*(sh|bash|zsh)/,                           label: 'remote script execution (wget|sh)' },
  { pattern: /\bchmod\s+777\b/,                                        label: 'chmod 777' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/,                    label: 'system shutdown/reboot' },
  { pattern: /\bgit\s+push\s+(-[^\s]*f|--force)/,                     label: 'git force push' },
  { pattern: /\bnpm\s+publish\b/,                                      label: 'npm publish' },
  { pattern: /\bmkfs\b/,                                               label: 'filesystem format (mkfs)' },
  { pattern: /\bdd\s+if=/,                                             label: 'raw disk write (dd)' },
];

/** System package management patterns (member only) */
const DENY_SYSPACKAGE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(apt|apt-get)\s+(install|remove|purge|autoremove)\b/,  label: 'apt package management' },
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,    label: 'systemctl service control' },
  { pattern: /\bservice\s+\S+\s+(start|stop|restart)\b/,              label: 'service control' },
];

// ─── Viewer whitelist ────────────────────────────────────────────────────────

const VIEWER_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Find', 'Ls', 'WebFetch', 'WebSearch', 'AskUserQuestion',
  // Read-only Pi custom tools (capitalized by wrapPiTools)
  'ExcelRead', 'ExcelQuery', 'ExcelDiff', 'PdfRead',
]);

// ─── Factory ─────────────────────────────────────────────────────────────────

export type DamageCheckResult = { allowed: true } | { allowed: false; message: string };

export function buildDamageControl(
  role: TowerRole | string,
): (toolName: string, input: Record<string, unknown>) => DamageCheckResult {
  // Unknown roles (e.g. legacy 'user') → treat as member
  const effectiveRole: TowerRole = VALID_ROLES.has(role) ? (role as TowerRole) : 'member';

  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    // ── Viewer: whitelist-only ──
    if (effectiveRole === 'viewer') {
      if (!VIEWER_ALLOWED_TOOLS.has(toolName)) {
        return { allowed: false, message: `[Damage Control] Viewer role cannot use the ${toolName} tool.` };
      }
      return { allowed: true };
    }

    // ── Admin: unrestricted ──
    if (effectiveRole === 'admin') {
      return { allowed: true };
    }

    // ── Operator / Member / Guest: check Bash commands ──
    if (toolName === 'Bash') {
      const command = String(input.command || '');

      // DENY_SYSTEM (operator + member + guest)
      for (const rule of DENY_SYSTEM) {
        if (rule.pattern.test(command)) {
          return { allowed: false, message: `[Damage Control] Blocked: ${rule.label}. The ${effectiveRole} role cannot run this command.` };
        }
      }

      // DENY_SYSPACKAGE (member + guest only — operator is exempt)
      if (effectiveRole === 'member' || effectiveRole === 'guest') {
        for (const rule of DENY_SYSPACKAGE) {
          if (rule.pattern.test(command)) {
            return { allowed: false, message: `[Damage Control] Blocked: ${rule.label}. The ${effectiveRole} role cannot manage system packages.` };
          }
        }
      }
    }

    return { allowed: true };
  };
}

// ─── Secret File Protection ──────────────────────────────────────────────────
// Blocks file/Bash access to common secret-bearing paths regardless of project
// boundary. The systemPrompt has a "Never reveal secrets" rule but prompt
// injection or careless prompts can override it — this is the code-level
// backstop. Applies to all 4 AI execution paths via buildToolGuard.
//
// Policy (2026-04-29):
//   admin    → console.warn but allow (legit ops work + manual override)
//   other    → block hard with a clear message
//
// Whitelist: .env.example is fine (template, no real secrets).

// ── .claude/ allowlist ──────────────────────────────────────────────────────
// Skills invoke a small set of fixed entry points under ~/.claude/ that the
// Tower team has reviewed for secret-bearing content. Without this allowlist
// the broad `.claude/` rule below would block every web-capture / browser-live
// / fleet / memory call from non-admin sessions, even though those scripts
// hold no secrets. New entries: add ONLY after verifying the file does not
// read .env / credentials / API keys, and document in a decision file.
//
// Background: workspace/decisions/2026-05-07-secret-guard-claude-allowlist.md
const CLAUDE_HOME_ALLOWLIST: RegExp[] = [
  // 1. Legacy lifecycle scripts dropped by browser-live setup scripts.
  //    These start/stop browser daemons and read no secrets.
  /(^|\/)\.claude\/scripts\/[\w.-]+\.(sh|mjs|js|py)$/,
  // 2. /memory skill — project-scoped FTS over ~/.claude/memory.db.
  //    Native single-user store with Tower's project-scope filter on top.
  //    Filter is voluntary (CLAUDE_PROJECT_DIR can be overridden), so cross-
  //    project content leak is technically possible — tracked as a separate
  //    hardening item, not a secret-guard concern.
  /(^|\/)\.claude\/hooks\/memory\/[\w.-]+\.(mjs|js|sh)$/,
  // 3. /fleet skill — deploy orchestration. deploy-profile.sh handles
  //    *remote* self-hosted-server .env files via ssh; the local file itself reads
  //    no secrets. library.yaml lists secret *names* but no values.
  /(^|\/)\.claude\/skills\/library\/(deploy-profile\.sh|library\.yaml)$/,
  // 4. SKILL.md scanning — selfheal, tower-guide-update, skill-architect.
  //    Read-only metadata files inside ~/.claude/skills/<name>/.
  /(^|\/)\.claude\/skills\/[\w.-]+\/SKILL\.md$/,
  // 5. Plugin assets — offer-plan reads logos / icons / readme.
  /(^|\/)\.claude\/plugins\/.+\.(png|jpg|jpeg|svg|gif|webp|md)$/,
  // 6. 스킬 read-only 가이드 파일 (root level) — reference.md, README.md, GUIDE.md,
  //    USAGE.md, TEMPLATE.md, EXAMPLES.md, CHANGELOG.md, NOTES.md, CONVENTIONS.md,
  //    SCHEMA.md, HANDBOOK.md. 스킬 컨벤션상 비밀 없는 사용 가이드 / 스키마 / 예시.
  //    SKILL.md 와 동격 — guest/member 도 스킬 정상 사용에 필요.
  //    근거: workspace/decisions/2026-05-23-secret-guard-skill-readonly-allowlist.md
  /(^|\/)\.claude\/skills\/[\w.-]+\/(reference|references|README|GUIDE|USAGE|TEMPLATE|TEMPLATES|EXAMPLE|EXAMPLES|CHANGELOG|NOTES|CONVENTIONS|SCHEMA|HANDBOOK)\.md$/i,
  // 7. 스킬 read-only 자료 폴더 — templates/, examples/, references/, samples/,
  //    assets/, data/, fixtures/. .pptx 템플릿, yaml 스키마, 샘플 데이터, 폰트, 로고 등.
  //    ABSOLUTE_SECRET_PATTERNS 가 .env / credentials / SSH 키는 별도로 잡아냄
  //    (allowlist 가 못 풀음 — checkAbsoluteSecret 우선 적용).
  /(^|\/)\.claude\/skills\/[\w.-]+\/(templates|examples|references|samples|assets|data|fixtures)\/.+$/,
  // 8. 스킬 scripts/ 안 데이터 파일 (.sh/.mjs/.js/.py 는 #1 에서 이미 허용).
  //    스킬 scripts 폴더엔 종종 .yaml 설정, .md 메모, .json 데이터 동거.
  /(^|\/)\.claude\/skills\/[\w.-]+\/scripts\/[\w.-]+\.(md|json|yaml|yml|txt|csv|toml)$/,
];

/**
 * Absolute secret patterns — these ALWAYS deny, allowlist cannot override.
 * Decision (2026-05-23): split from the unified SECRET_PATH_PATTERNS so that
 * broader allowlist patterns (e.g. `skills/<name>/templates/.+`) cannot
 * accidentally expose a `.env` or `credentials.json` someone drops inside a
 * templates/ folder.
 *
 * Background: workspace/decisions/2026-05-23-secret-guard-skill-readonly-allowlist.md
 */
const ABSOLUTE_SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // .env and .env.<env>, but NOT .env.example or .env.sample
  { pattern: /(^|\/)\.env(\.(?!example$|sample$|template$)[\w-]+)?$/, label: '.env file' },
  // credentials.json variants
  { pattern: /(^|\/)[a-zA-Z0-9_-]*credentials[a-zA-Z0-9_-]*\.json$/i, label: 'credentials JSON' },
  // .mcp.json — MCP server configs commonly carry tokens (2026-05-02)
  { pattern: /(^|\/)\.mcp\.json$/, label: 'MCP config' },
  // ~/.aws/credentials, ~/.aws/config
  { pattern: /\/\.aws\/(credentials|config)$/, label: 'AWS credentials' },
  // SSH private keys
  { pattern: /\/\.ssh\/id_(rsa|dsa|ecdsa|ed25519)$/, label: 'SSH private key' },
  // GnuPG
  { pattern: /\/\.gnupg\//, label: 'GnuPG home' },
];

/**
 * Claude home — gated by CLAUDE_HOME_ALLOWLIST. Without the allowlist this
 * would block every web-capture / browser-live / fleet / memory call from
 * non-admin sessions. With the allowlist, only the verified-safe fixed
 * entry points pass through.
 */
const CLAUDE_HOME_PATTERN = {
  pattern: /(^|\/)\.claude(\/|$)/,
  label: 'Claude home (.claude)',
};

/**
 * Build a secret-path checker. Returns deny for non-admin roles when a
 * secret-looking path is referenced; admin gets logged-but-allowed.
 *
 * Hooked into buildToolGuard (project-access.ts) so all 3 AI execution
 * paths (Engine.run, channelReply, task-runner) inherit it.
 */
export function buildSecretGuard(role: TowerRole | string) {
  const effectiveRole: TowerRole = VALID_ROLES.has(role) ? (role as TowerRole) : 'member';

  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    // Collect candidate paths from this tool call (mirrors buildPathEnforcement)
    const paths: string[] = [];
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string') paths.push(input[key] as string);
    }
    if (Array.isArray(input.files)) {
      paths.push(...input.files.filter((p): p is string => typeof p === 'string'));
    }
    if (toolName === 'Bash' && typeof input.command === 'string') {
      // Extract path-like tokens — anything containing /. or starting with .env
      const cmd = input.command as string;
      const tokens = cmd.match(/[^\s;&|>"'`]+/g) || [];
      for (const tok of tokens) {
        if (tok.includes('/.') || tok.includes('\\.') || /^\.env(\.|$)/.test(tok) || /credentials/i.test(tok)) {
          paths.push(tok);
        }
      }
    }

    const denyMessage = (label: string, p: string) =>
      `[Secret Guard] Blocked: ${label} ("${p}") is off-limits to the ${effectiveRole} role. ` +
      `If you need this value, ask the user in plain text — do NOT read it via Read/Bash. ` +
      `Templates like .env.example are fine.`;

    for (const p of paths) {
      // (a) ABSOLUTE secrets — checked FIRST, allowlist cannot override.
      //     .env / credentials.json / .mcp.json / .aws/credentials / SSH keys /
      //     GnuPG. Even if a future allowlist pattern would match this path,
      //     these absolute patterns deny first. Prevents accidents like
      //     someone dropping a `.env` inside a skill's `templates/` folder.
      for (const rule of ABSOLUTE_SECRET_PATTERNS) {
        if (rule.pattern.test(p)) {
          if (effectiveRole === 'admin') {
            console.warn(`[Secret Guard] admin accessed ${rule.label}: "${p}" via ${toolName} (allowed-but-logged)`);
            return { allowed: true };
          }
          return { allowed: false, message: denyMessage(rule.label, p) };
        }
      }

      // (b) Claude home — gated by CLAUDE_HOME_ALLOWLIST.
      //     If the path is under .claude/ AND matches an allowlist pattern → allowed.
      //     If under .claude/ but NOT on allowlist → denied (non-admin).
      if (CLAUDE_HOME_PATTERN.pattern.test(p)) {
        let onAllowlist = false;
        for (const allow of CLAUDE_HOME_ALLOWLIST) {
          if (allow.test(p)) { onAllowlist = true; break; }
        }
        if (onAllowlist) continue;
        if (effectiveRole === 'admin') {
          console.warn(`[Secret Guard] admin accessed ${CLAUDE_HOME_PATTERN.label}: "${p}" via ${toolName} (allowed-but-logged)`);
          return { allowed: true };
        }
        return { allowed: false, message: denyMessage(CLAUDE_HOME_PATTERN.label, p) };
      }
    }

    return { allowed: true };
  };
}

// ─── Path Enforcement ───────────────────────────────────────────────────────

/**
 * Build a path enforcement checker that restricts file tool access
 * to within the given allowedPath directory.
 */
export function buildPathEnforcement(allowedPath: string) {
  const root = path.resolve(allowedPath) + path.sep;
  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    const paths: string[] = [];
    // File tools: file_path, path, notebook_path params, files[]
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string') paths.push(input[key] as string);
    }
    if (Array.isArray(input.files)) {
      paths.push(...input.files.filter((p): p is string => typeof p === 'string'));
    }
    // Bash: extract absolute paths from command (skip safe system paths)
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const absPaths = (input.command as string).match(
        /(?:^|\s)(\/(?!dev\/null|dev\/stderr|dev\/stdout|tmp\/|usr\/bin\/|bin\/)[^\s;&|>"']+)/g
      );
      if (absPaths) paths.push(...absPaths.map(p => p.trim()));
    }
    for (const p of paths) {
      const resolved = path.resolve(p);
      // Allow exact match (the root dir itself) or anything inside it
      if (resolved + path.sep !== root && !resolved.startsWith(root)) {
        console.warn(`[Path Enforcement] Denied: "${p}" outside root "${root.slice(0, -1)}" (tool: ${toolName})`);
        return { allowed: false, message: `[Path Restriction] Access denied: "${p}" is outside your allowed workspace.` };
      }
    }
    return { allowed: true };
  };
}
