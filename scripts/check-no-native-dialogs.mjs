#!/usr/bin/env node
/**
 * Guard against accidentally re-introducing native browser dialogs.
 *
 * Why: Chromium permanently suppresses window.confirm/alert/prompt the moment
 * the user checks "이 페이지에서 추가 대화상자를 표시하지 않도록 설정"
 * (or its English equivalent). After that, *every* destructive-action confirm
 * silently returns false on prod, and users lose the confirm path with no
 * feedback. Tower routes everything through useConfirm / usePrompt + toast
 * instead. See workspace/decisions/2026-05-05-no-native-dialogs.md.
 *
 * What we forbid in packages/frontend/src/**:
 *   - window.confirm / window.alert / window.prompt
 *   - bare confirm(...) / alert(...) / prompt(...) at function-call position
 *
 * Allowed by exception (they ARE the replacement implementation):
 *   - packages/frontend/src/components/common/ConfirmDialog.tsx
 *   - packages/frontend/src/hooks/useDialog.tsx
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'packages/frontend/src');

const ALLOWLIST = new Set([
  // Files where 'confirm()' refers to local hook helpers, not the global.
  // The implementation files use the names internally.
  path.join(SRC, 'components/common/ConfirmDialog.tsx'),
  path.join(SRC, 'hooks/useDialog.tsx'),
]);

// Strict regex for "calling the global". Matches:
//   window.confirm(...)
//   confirm(...)              (start of line / after non-identifier char)
// Misses (intentionally):
//   foo.confirm(...)          → method, not the global
//   await confirm(...)        → ALSO matches; the linter is line-based, but
//                               since await + identifier reads the local
//                               binding, we exclude `await` and `=` contexts
//                               by requiring the identifier to NOT be
//                               preceded by `await `/`=`/`,`/`(` ... wait,
//                               that's hopeless. Easier: callers of the
//                               *hook* always destructure as a local const
//                               (`const confirm = useConfirm()`), so the
//                               line `await confirm({...})` is fine because
//                               `confirm` resolves to the local. We only
//                               flag direct-string-arg calls like
//                               `confirm('msg')` where the arg is a string
//                               literal — that's the native API shape.
const PATTERNS = [
  // window.<name>(
  { re: /\bwindow\.(confirm|alert|prompt)\s*\(/g, msg: 'Use useConfirm/usePrompt or toastError instead of window.{name}().' },
  // bare alert('...') with string arg → always native (hook is `confirm({...})` with object arg)
  { re: /(^|[^.\w$])(alert)\s*\(\s*['"`]/g, msg: 'Use toastError instead of alert().' },
  // bare confirm('...') with string arg → native
  { re: /(^|[^.\w$])(confirm)\s*\(\s*['"`]/g, msg: 'Use useConfirm({title, message, ...}) instead of confirm("...").' },
  // bare prompt('...') with string arg → native
  { re: /(^|[^.\w$])(prompt)\s*\(\s*['"`]/g, msg: 'Use usePrompt({title, message, ...}) instead of prompt("...").' },
];

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      yield full;
    }
  }
}

const violations = [];
for await (const file of walk(SRC)) {
  if (ALLOWLIST.has(file)) continue;
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments quickly (single-line // and /* ... */ on one line).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const { re, msg } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim(), msg });
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error('❌ Native browser dialog usage detected:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.msg}\n`);
  }
  console.error(`Found ${violations.length} violation(s).`);
  console.error('Background: workspace/decisions/2026-05-05-no-native-dialogs.md');
  process.exit(1);
}

console.log(`✓ No native browser dialogs in packages/frontend/src/ (${violations.length === 0 ? 'clean' : violations.length})`);
