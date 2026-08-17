#!/usr/bin/env node
/**
 * Guard Pi harness tools against context/path/temp regressions.
 *
 * Why: host-side Pi custom tools run in the Tower backend, but users often pass
 * Runtime Box paths like /workspace/foo.xlsx. Path-aware tools must therefore be
 * created with session context (cwd/projectRoot/sessionId), resolve /workspace
 * safely, and avoid shared singleton temp files such as /tmp/tower_py_run.py.
 *
 * This is intentionally source-level and cheap so it can run in preflight.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENGINES = path.join(ROOT, 'packages/backend/engines');

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git']);
const FILE_RE = /\.ts$/;

const PATH_AWARE_FACTORY_ALLOWLIST = new Map([
  // Backward-compatible aliases that delegate to factories. They must not be
  // mounted directly from tool-assembly, but the exported const itself is OK.
  ['packages/backend/engines/pi-finance-tools.ts', new Set(['excelReadTool', 'excelQueryTool'])],
  ['packages/backend/engines/pi-finance-tools-extra.ts', new Set(['pdfReadTool', 'excelWriteTool', 'excelDiffTool'])],
]);

const SINGLETON_TOOL_ALLOWLIST = new Map([
  // These tools do not accept filesystem paths and are intentionally singleton.
  ['packages/backend/engines/pi-todo-tool.ts', new Set(['todoWriteTool'])],
  ['packages/backend/engines/pi-shared-task-tool.ts', new Set(['sharedTaskCreateTool', 'sharedTaskUpdateTool', 'sharedTaskListTool'])],
  ['packages/backend/engines/pi-web-tools.ts', new Set(['webFetchTool', 'webSearchTool'])],
]);

const SOURCE_RULES = [
  {
    re: /['"]\/tmp\/tower_[^'"]*['"]/g,
    message: 'Do not use shared fixed /tmp/tower_* files; use fs.mkdtempSync/os.tmpdir with per-call names.',
  },
  {
    re: /sys\.path\.insert\(0,\s*['"]\/tmp['"]\)/g,
    message: 'Do not import helper modules from shared /tmp; materialize helpers into a per-call temp dir.',
  },
  {
    re: /require\(['"]fs['"]\)/g,
    message: 'Backend TypeScript is ESM; import fs from node:fs / fs promises instead of require("fs").',
  },
  {
    re: /execSync\(\s*`python3\s+\$\{/g,
    message: 'Do not shell-interpolate Python script paths; use execFileSync("python3", [scriptPath]).',
  },
  {
    re: /execSync\(\s*`python3\s+/g,
    message: 'Do not run python3 through shell template strings; use execFileSync("python3", [scriptPath]).',
  },
];

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('__')) continue;
      yield* walk(full);
    } else if (entry.isFile() && FILE_RE.test(entry.name)) {
      yield full;
    }
  }
}

function lineFor(text, index) {
  return text.slice(0, index).split('\n').length;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isAllowedExport(fileRel, name) {
  return PATH_AWARE_FACTORY_ALLOWLIST.get(fileRel)?.has(name) || SINGLETON_TOOL_ALLOWLIST.get(fileRel)?.has(name);
}

const violations = [];

for await (const file of walk(ENGINES)) {
  const fileRel = rel(file);
  if (fileRel.includes('/__tests__/')) continue;
  const text = await fs.readFile(file, 'utf8');

  for (const { re, message } of SOURCE_RULES) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      violations.push({ file: fileRel, line: lineFor(text, match.index), text: match[0], message });
    }
  }

  const exportRe = /export\s+const\s+(\w+)\s*:\s*ToolDefinition\s*=\s*(?!create\w+Tool\s*\()/g;
  let match;
  while ((match = exportRe.exec(text))) {
    const name = match[1];
    if (isAllowedExport(fileRel, name)) continue;
    violations.push({
      file: fileRel,
      line: lineFor(text, match.index),
      text: match[0].replace(/\s+/g, ' '),
      message: 'Pi ToolDefinition singleton exports are easy to make context-blind. Prefer create*Tool(ctx); allowlist only stateless tools.',
    });
  }
}

// Tool assembly must mount the context-aware finance factories, not the legacy aliases.
const assemblyPath = path.join(ENGINES, 'pi/tool-assembly.ts');
const assembly = await fs.readFile(assemblyPath, 'utf8');
const assemblyRel = rel(assemblyPath);
for (const forbidden of ['pdfReadTool', 'excelWriteTool', 'excelDiffTool', 'excelReadTool,', 'excelQueryTool,']) {
  const idx = assembly.indexOf(forbidden);
  if (idx !== -1) {
    violations.push({
      file: assemblyRel,
      line: lineFor(assembly, idx),
      text: forbidden,
      message: 'Mount context-aware create*Tool({ cwd, projectRoot, sessionId }) factories in Pi tool assembly, not singleton aliases.',
    });
  }
}

if (!/wrapPiTools\(piTools, guard, \{ projectRoot: sessionProjectRoot \}\)/.test(assembly)) {
  violations.push({
    file: assemblyRel,
    line: 1,
    text: 'wrapPiTools(piTools, guard, { projectRoot: sessionProjectRoot })',
    message: 'Pi built-in tools must pass projectRoot into the ACL wrapper so /workspace paths are checked against the host project root.',
  });
}
if (!/wrapPiTools\(\[\.\.\.piTools, \.\.\.customTools, \.\.\.mcpTools(?:, \.\.\.projectMcpTools)?\], guard, \{ projectRoot: sessionProjectRoot \}\)/.test(assembly)) {
  violations.push({
    file: assemblyRel,
    line: 1,
    text: 'wrapPiTools([...piTools, ...customTools, ...mcpTools, ...projectMcpTools], guard, { projectRoot: sessionProjectRoot })',
    message: 'Pi custom/MCP tools must pass projectRoot into the ACL wrapper so /workspace paths are checked against the host project root.',
  });
}

if (violations.length > 0) {
  console.error('❌ Pi tool context-contract violations detected:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.message}\n`);
  }
  console.error(`Found ${violations.length} violation(s).`);
  console.error('Background: GitHub issue #109 / Runtime Box /workspace path handling and per-session temp isolation.');
  process.exit(1);
}

console.log('✓ Pi tool context contracts clean');
