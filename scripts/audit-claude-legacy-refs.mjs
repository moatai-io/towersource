#!/usr/bin/env node
// Read-only inventory for Claude Code / .claude legacy references.
// Purpose: classify existing references so Tower can retire Claude Code harness
// without breaking compatibility. See:
// ~/workspace/decisions/2026-06-10-claude-code-harness-retirement-plan.md

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(process.env.REPO_ROOT || process.cwd());

const DEFAULT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.md', '.json', '.yml', '.yaml', '.sh', '.sql', '.cjs', '.html', '.css',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.turbo', '.vite', 'coverage',
  '.worktrees', '.sandbox', '.claude', 'tmp', 'temp', '.tmp', '.temp', '.cache',
  // Generated runtime state / backups. Keep data/skills and data/runtime-skills scannable.
  'pi-session-backups', 'pi-session-recovery', 'session-backups', 'blobs',
]);

const PATTERNS = [
  // Match path-like .claude references, not JS property names like config.claudeEnabled.
  { key: 'dot_claude_path', re: /\.claude(?=$|[\/\-.\s`'"\)\]])(?:[-\/\w.]*)?/i },
  { key: 'claude_code', re: /Claude Code|claude code|CLAUDECODE|CLAUDE_CODE/i },
  { key: 'claude_sdk', re: /@anthropic-ai\/claude-agent-sdk|claude-agent-sdk|Claude Agent SDK/i },
  { key: 'claude_session_id', re: /claude_session_id|claudeSessionId|ClaudeSessionId/i },
  { key: 'claude_config_dir', re: /CLAUDE_CONFIG_DIR|configDir/i },
  { key: 'claude_accounts', re: /claude_accounts|ClaudeAccount|Claude Accounts/i },
  { key: 'claude_engine', re: /ClaudeEngine|claude-engine|claude-sdk/i },
  { key: 'legacy_skill_catalog', re: /library\.yaml|local-library\.yaml|deploy-profile\.sh/i },
];

const CATEGORY_RULES = [
  {
    category: 'runtime-critical',
    reason: 'Claude legacy engine / SDK / resume compatibility path',
    path: /(^|\/)packages\/backend\/(engines\/claude-engine\.ts|services\/ai\/claude-sdk\.ts|services\/workspace\/jsonl-utils\.ts|services\/deploy\/bwrap-sandbox\.ts)/,
  },
  {
    category: 'runtime-critical',
    reason: 'SDK/MCP adapter files still import Claude Agent SDK for legacy or bridge support',
    path: /(^|\/)packages\/backend\/mcp\/.*\.ts$|(^|\/)packages\/backend\/engines\/pi-mcp-adapter\.ts$/,
  },
  {
    category: 'runtime-critical',
    reason: 'DB migrations preserve existing Claude-era columns/tables and historical migration comments',
    path: /(^|\/)packages\/backend\/db\/migrations\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Migration runner comments reference legacy migration filenames',
    path: /(^|\/)packages\/backend\/db\/pg\.ts$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Engine-neutral or Pi migration code still maps legacy Claude fields',
    path: /(^|\/)packages\/backend\/(config\.ts|index\.ts|engines\/index\.ts|engines\/types\.ts|engines\/pi.*\.ts|engines\/pi\/.*\.ts|services\/session\/.*\.ts|services\/task\/task-runner\.ts|routes\/ws-handler\.ts|routes\/api\.ts|services\/room\/room-manager\.ts|services\/pm\/project-manager\.ts|services\/ai\/.*\.ts|services\/workspace\/.*\.ts|services\/workspace-guard\/.*\.ts)/,
  },
  {
    category: 'needs-migration',
    reason: 'Known non-core code path still directly depends on Claude SDK or .claude catalog; migrate after inventory',
    path: /(^|\/)packages\/backend\/services\/(deploy\/fleet-manager|git\/auto-commit-message|pin-manager)\.ts$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Git service comments still mention legacy Claude engine call sites',
    path: /(^|\/)packages\/backend\/services\/git\/git-manager\.ts$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Hook/security modules keep Claude SDK hook types while Pi adapter parity exists',
    path: /(^|\/)packages\/backend\/services\/(audit|publishing|security)\/.*\.ts$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Shared package keeps deprecated Claude field aliases during engine-neutral migration',
    path: /(^|\/)packages\/shared\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Credential/account admin remains for explicit Claude fallback',
    path: /(^|\/)packages\/backend\/services\/auth\/(credential-store|credential-health|customer-scope).*\.ts$|(^|\/)packages\/backend\/routes\/api\.ts$/,
    text: /claude|configDir|credentials|library\.yaml/i,
  },
  {
    category: 'compatibility-shim',
    reason: 'Pi-only / engine migration tests intentionally mention legacy Claude paths',
    path: /(^|\/)(__tests__\/|packages\/.*\.(test|source\.test)\.(ts|tsx|js|mjs)$)/,
  },
  {
    category: 'frontend-label',
    reason: 'Frontend still carries deprecated Claude naming aliases or labels',
    path: /(^|\/)packages\/frontend\//,
  },
  {
    category: 'migration-backfill',
    reason: 'One-shot migration/backfill script reads legacy Claude data',
    path: /(^|\/)scripts\/backfill-memory-db-to-pg\.ts$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Tower-managed deploy bridge intentionally overlays repo-owned skill source onto legacy transport',
    path: /(^|\/)scripts\/skills\/deploy-managed-skills\.sh$/,
    text: /\.claude|library\.yaml|deploy-profile\.sh/i,
  },
  {
    category: 'compatibility-shim',
    reason: 'Fleet/skill scripts currently depend on legacy skill catalog transport',
    path: /(^|\/)scripts\/(fleet|azure)\//,
    text: /\.claude|library\.yaml|deploy-profile\.sh/i,
  },
  {
    category: 'compatibility-shim',
    reason: 'Setup/backup/selfheal script keeps legacy compatibility',
    path: /(^|\/)scripts\/(backup\.sh|auto-selfheal\.sh|scan-project-skills\.mjs)$/,
  },
  {
    category: 'needs-migration',
    reason: 'Azure/bootstrap/fleet verification scripts still install or verify Claude-specific paths',
    path: /(^|\/)scripts\/(azure\/bootstrap-prod\.sh|fleet\/deploy-verify-plus\.sh)$/,
  },
  {
    category: 'docs-historical',
    reason: 'Decision records are historical source of truth',
    path: /(^|\/)workspace\/decisions\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Tower-owned managed skill catalog documents legacy fallback only during SSOT migration',
    path: /(^|\/)config\/skills\/managed-skills\.yaml$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Repo-managed skill sources may mention legacy paths only as fallback/negative guidance during migration',
    path: /(^|\/)skills\/managed\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Operator skill sources still document or wrap legacy fleet/customer transport during migration',
    path: /(^|\/)skills\/(fleet|skill-registry|skill-registry-orchestration|materialize-managed-skills|managed-skill-rollout)\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Skill sources/materialized outputs still describe or wrap legacy Claude transport',
    path: /(^|\/)(skills\/system|data\/runtime-skills|data\/skills|\.tower\/skills)\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Legacy memory hooks remain for admin CLI compatibility until retired separately',
    path: /(^|\/)memory-hooks\//,
  },
  {
    category: 'docs-historical',
    reason: 'Archived legacy/break-glass runbooks are preserved for repair context, not normal runtime prompts',
    path: /(^|\/)docs\/claude-headless-login\.md$/,
  },
  {
    category: 'docs-historical',
    reason: 'Historical product/spec/planning notes and generated changelog',
    path: /(^|\/)(prd\.md|containerize\.md|bwrap\.md|migrate_to_chat_ability\.md|CHANGELOG\.md|codify\.md|progress\.md)$|(^|\/)docs\/(plans|changelog|.*investigation|.*analysis|.*prd)/,
  },
  {
    category: 'docs-historical',
    reason: 'Module README/_DECISIONS files record existing architecture and should be updated intentionally',
    path: /(^|\/)packages\/backend\/services\/.*\/(README|_DECISIONS)\.md$/,
  },
  {
    category: 'migration-backfill',
    reason: 'Legacy database migration/import scripts mention old schema while moving data',
    path: /(^|\/)packages\/backend\/scripts\/(migrate-sqlite-to-pg\.ts|usage-report\.sql)$/,
  },
  {
    category: 'docs-actionable',
    reason: 'Actionable runbook/install docs may need Pi-first rewrite or deprecated banner',
    path: /(^|\/)(README\.md|README\.ko\.md|INSTALL\.md|setup\.sh|start\.sh|AGENTS\.md|templates\/workspace\/CLAUDE\.md)$|(^|\/)docs\/(azure-customer-deployment-runbook|azure-prod-deployment|backup-recovery-runbook|customer-servers|new-vm-install-checklist|skill-distribution|tower-guide\/.*)\.md$/,
  },
  {
    category: 'compatibility-shim',
    reason: 'Package manifests retain Claude SDK dependency until legacy engine is archived',
    path: /(^|\/)(package\.json|package-lock\.json|packages\/backend\/package\.json)$/,
  },
  {
    category: 'docs-actionable',
    reason: 'Developer process templates mention legacy Claude paths and should be revised with docs',
    path: /(^|\/)\.github\//,
  },
  {
    category: 'compatibility-shim',
    reason: 'Backend skill/prompt/access services still merge legacy skill catalog and prompt names',
    path: /(^|\/)packages\/backend\/services\/(skill|system-prompt|pm\/project-access|damage-control).*\.(ts|tsx)$/,
  },
  {
    category: 'self',
    reason: 'This audit script intentionally contains legacy patterns',
    path: /(^|\/)scripts\/audit-claude-legacy-refs\.mjs$/,
  },
];

function usage() {
  console.log(`Usage: node scripts/audit-claude-legacy-refs.mjs [options]\n\nOptions:\n  --json                 Print machine-readable JSON\n  --fail-on-forbidden    Exit 2 if unclassified/forbidden references exist\n  --root <path>          Repository root (default: cwd)\n  --include-docs         Include docs-historical lines in text output\n  --prompt-visible       Show only references likely to be read by AI prompts/tool descriptions\n  --limit <n>            Max text rows per category (default: 30)\n  -h, --help             Show help\n\nRead-only. Does not move, delete, or write files.\n`);
}

function parseArgs(argv) {
  const opts = {
    root: REPO_ROOT,
    json: false,
    failOnForbidden: false,
    includeDocs: false,
    promptVisible: false,
    limit: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--fail-on-forbidden') opts.failOnForbidden = true;
    else if (arg === '--include-docs') opts.includeDocs = true;
    else if (arg === '--prompt-visible') opts.promptVisible = true;
    else if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '-h' || arg === '--help') { usage(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.limit) || opts.limit < 1) opts.limit = 30;
  return opts;
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.endsWith('.tsbuildinfo');
}

function shouldScanFile(file) {
  const base = path.basename(file);
  if (base.endsWith('.tsbuildinfo')) return false;
  if (base === 'package-lock.json') return true;
  const ext = path.extname(file);
  return DEFAULT_EXTENSIONS.has(ext);
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) yield* walk(full);
    } else if (entry.isFile() && shouldScanFile(full)) {
      yield full;
    }
  }
}

function normalizeRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function classify(rel, text) {
  for (const rule of CATEGORY_RULES) {
    if (!rule.path.test(rel)) continue;
    if (rule.text && !rule.text.test(text)) continue;
    return { category: rule.category, reason: rule.reason };
  }
  return {
    category: 'forbidden-new-ref',
    reason: 'No allowlist rule matched; review before keeping this reference',
  };
}

function matchingPatternKeys(line) {
  return PATTERNS.filter((p) => p.re.test(line)).map((p) => p.key);
}

function promptVisibility(rel, text, category) {
  // Prompt-visible means the reference is likely to be injected into an AI
  // prompt, exposed as a tool/skill description, or shown as user-facing UI
  // copy. These are higher-priority than runtime/db compatibility references
  // because they can make new Pi-first runs keep talking about Claude Code.
  if (category === 'docs-historical' || category === 'migration-backfill') return null;
  if (/^\s*import\b/.test(text)) return null;
  if (/(^|\/)workspace\/projects\/.*\/records\//.test(rel)) return null;
  // `data/skills/company` is the legacy company archive, not the Tower runtime
  // prompt source. Live/default shared skills come from teamskills and managed
  // materialization. Keep these references in the general audit, but do not let
  // archived implementation notes dominate the prompt-visible cleanup queue.
  if (/(^|\/)data\/skills\/company\//.test(rel)) return null;

  if (/(^|\/)AGENTS\.md$|(^|\/)templates\/workspace\/AGENTS\.md$/.test(rel)) {
    return 'prompt-visible-critical';
  }
  if (/(^|\/)packages\/backend\/mcp\/.*\.ts$|(^|\/)packages\/backend\/engines\/pi-.*tool.*\.ts$|(^|\/)packages\/backend\/engines\/pi\/.*\.ts$/.test(rel)) {
    return 'prompt-visible-tooling';
  }
  if (/(^|\/)(skills\/.*|data\/runtime-skills\/.*|data\/skills\/.*|\.tower\/skills\/.*)\/(SKILL\.md|README\.md|handbook\.md|spec\.md|testing-guide\.md|validation\.md|cookbook\/.*\.md)$/.test(rel)) {
    return 'prompt-visible-skill';
  }
  if (/(^|\/)packages\/backend\/services\/(system-prompt|system-prompt-fragments|ai\/ai-quick-reply).*\.(ts|md)$/.test(rel)) {
    return 'prompt-visible-system-prompt';
  }
  if (/(^|\/)packages\/frontend\//.test(rel)) {
    // Backend/API compatibility field names in frontend state and request code are
    // not user-facing copy. Keep them in the general compatibility audit, but do
    // not let implementation identifiers dominate the UI wording cleanup queue.
    if (/(models\.claude|claude_account_id|ClaudeAccount\w*|configDir\w*|claudeExecutable)/.test(text)) return null;
    return 'prompt-visible-ui';
  }
  if (category === 'docs-actionable') {
    return 'prompt-visible-docs';
  }
  if (category === 'forbidden-new-ref') {
    return 'prompt-visible-review';
  }
  return null;
}

function scanFile(root, file) {
  const rel = normalizeRel(root, file);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const patternKeys = matchingPatternKeys(line);
    if (patternKeys.length === 0) continue;
    const { category, reason } = classify(rel, line);
    const exposure = promptVisibility(rel, line, category);
    out.push({
      file: rel,
      line: i + 1,
      category,
      exposure,
      reason,
      patterns: patternKeys,
      text: line.trim().slice(0, 500),
    });
  }
  return out;
}

function summarize(findings) {
  const categories = new Map();
  const exposures = new Map();
  const patterns = new Map();
  const files = new Map();

  for (const item of findings) {
    categories.set(item.category, (categories.get(item.category) || 0) + 1);
    if (item.exposure) exposures.set(item.exposure, (exposures.get(item.exposure) || 0) + 1);
    files.set(item.file, (files.get(item.file) || 0) + 1);
    for (const p of item.patterns) patterns.set(p, (patterns.get(p) || 0) + 1);
  }

  const toSortedObject = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    totalFindings: findings.length,
    totalFiles: files.size,
    categories: toSortedObject(categories),
    promptVisible: toSortedObject(exposures),
    patterns: toSortedObject(patterns),
    topFiles: [...files.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30)
      .map(([file, count]) => ({ file, count })),
  };
}

function printText(report, opts) {
  if (opts.promptVisible) {
    report = {
      ...report,
      findings: report.findings.filter((f) => f.exposure),
    };
    report.summary = summarize(report.findings);
  }

  console.log('Claude legacy reference audit (read-only)');
  console.log(`root: ${report.root}`);
  console.log(`findings: ${report.summary.totalFindings} lines across ${report.summary.totalFiles} files`);
  console.log('');

  console.log('## Summary by category');
  for (const [category, count] of Object.entries(report.summary.categories)) {
    console.log(`- ${category}: ${count}`);
  }
  console.log('');

  if (Object.keys(report.summary.promptVisible || {}).length > 0) {
    console.log('## Prompt-visible exposure');
    for (const [exposure, count] of Object.entries(report.summary.promptVisible)) {
      console.log(`- ${exposure}: ${count}`);
    }
    console.log('');
  }

  console.log('## Top files');
  for (const item of report.summary.topFiles.slice(0, 12)) {
    console.log(`- ${item.count.toString().padStart(4, ' ')}  ${item.file}`);
  }
  console.log('');

  const categories = [...new Set(report.findings.map((f) => f.category))].sort();
  for (const category of categories) {
    if (category === 'docs-historical' && !opts.includeDocs) continue;
    const rows = report.findings.filter((f) => f.category === category);
    console.log(`## ${category} (${rows.length})`);
    for (const item of rows.slice(0, opts.limit)) {
      const exposure = item.exposure ? ` exposure=${item.exposure}` : '';
      console.log(`- ${item.file}:${item.line} [${item.patterns.join(',')}]${exposure}`);
      console.log(`  ${item.text}`);
    }
    if (rows.length > opts.limit) console.log(`  ... ${rows.length - opts.limit} more (use --json or --limit)`);
    console.log('');
  }

  if ((report.summary.categories['forbidden-new-ref'] || 0) > 0) {
    console.log('⚠ forbidden-new-ref entries need review or an explicit allowlist rule.');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);
  const findings = [];
  for (const file of walk(root)) findings.push(...scanFile(root, file));

  let report = {
    root,
    generatedAt: new Date().toISOString(),
    policy: '2026-06-10-claude-code-harness-retirement-plan',
    summary: summarize(findings),
    findings,
  };

  if (opts.promptVisible) {
    report = {
      ...report,
      findings: report.findings.filter((f) => f.exposure),
    };
    report.summary = summarize(report.findings);
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printText(report, opts);

  if (opts.failOnForbidden && (report.summary.categories['forbidden-new-ref'] || 0) > 0) {
    process.exit(2);
  }
}

try {
  main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
