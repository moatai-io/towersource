#!/usr/bin/env node
/**
 * Owns: reproducible inventory of frontend user-facing copy candidates.
 * Public API: CLI flags --csv, --summary, --root, and --dry-run.
 *
 * This is intentionally a candidate generator, not an auto-translator. It uses
 * TypeScript's AST to retain source locations and leaves final visibility and
 * translation-policy decisions to human review.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const repoRoot = process.cwd();
const workspaceRoot = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || path.dirname(repoRoot), 'workspace');
const defaults = {
  root: path.join(repoRoot, 'packages/frontend/src'),
  csv: path.join(workspaceRoot, 'projects/tower/reports/frontend-copy-inventory.csv'),
  summary: path.join(workspaceRoot, 'projects/tower/reports/frontend-copy-inventory-summary.md'),
};

function parseArgs(argv) {
  const result = { ...defaults, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--root' || arg === '--csv' || arg === '--summary') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      result[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/frontend-copy-inventory.mjs [--root PATH] [--csv PATH] [--summary PATH] [--dry-run]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const sourceExtensions = new Set(['.ts', '.tsx']);
const ignoredPathPattern = /(?:^|\/)(?:locales|test-stubs|assets)(?:\/|$)|\.(?:test|source\.test)\.[^.]+$/;
const visibleProps = new Set(['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'label']);
const visibleCalls = /^(?:toast(?:\.(?:success|error|warning|info|message))?|alert|confirm|prompt|showToast|addToast|setError|setStatusMessage|openDialog)$/;
const nonCopyAttributePattern = /^(?:className|id|key|name|type|role|href|src|path|value|defaultValue|data-|on[A-Z])/;
const technicalOnlyPattern = /^(?:[a-z0-9_.\-/]+|#[0-9a-f]{3,8}|\d+(?:\.\d+)?(?:px|rem|em|%|ms|s)?|https?:\/\/\S+)$/i;
const naturalLanguagePattern = /[가-힣]|[A-Za-z]{2,}(?:[\s,!?():;'’“”"-]+[A-Za-z가-힣]{1,})*/;

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function hasCopySignal(value) {
  const text = normalizeText(value);
  if (text.length < 2 || text.length > 500) return false;
  if (!naturalLanguagePattern.test(text) || technicalOnlyPattern.test(text)) return false;
  if (/^(?:true|false|null|undefined|auto|none|button|text|password|email|checkbox)$/i.test(text)) return false;
  return true;
}

function detectLanguage(text) {
  const korean = /[가-힣]/.test(text);
  const english = /[A-Za-z]{2,}/.test(text);
  if (korean && english) return 'mixed';
  if (korean) return 'ko';
  if (english) return 'en';
  return 'neutral';
}

function sourceKindPriority(kind) {
  return ({ 'jsx_text': 'P1', 'visible_prop': 'P1', 'feedback_call': 'P1', 'jsx_expression': 'P2', 'ui_object_property': 'P2', 'ui_string_collection': 'P2', 'ui_return_literal': 'P2' })[kind] ?? 'P3';
}

function isUiCollectionName(name) {
  return /(?:LINES|LABELS|MESSAGES|PROMPTS|OPTIONS|STATUSES|COPY|TEXTS|TITLES|DESCRIPTIONS)$/i.test(name);
}

/** Excludes formatting-only return values while retaining words that require translation. */
function isFormattingOnlyReturn(text) {
  const withoutExpressions = text.replaceAll('{{expression}}', '').trim();
  if (/^(?:pi|local):$/i.test(withoutExpressions)) return true;
  if (/^(?:tower:|(?:[a-z]+-)?(?:bg|text|border|tone|scale|shadow|ring|opacity)-)/i.test(withoutExpressions)) return true;
  if (/^[-T:/.\s]+$/.test(withoutExpressions)) return true;
  return /^[~$€£¥₩+\-/:,.%()\s]*(?:B|KB|MB|GB|TB|K|M|k|ms|s|m|h|d)?[~$€£¥₩+\-/:,.%()\s]*$/.test(withoutExpressions);
}

function nearestVariableName(node) {
  let current = node;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return '';
}

function areaFor(relativePath) {
  const parts = relativePath.split('/');
  const anchor = parts.findIndex(part => part === 'components' || part === 'features');
  if (anchor >= 0 && parts[anchor + 1]) return parts[anchor + 1];
  if (parts[0] === 'tours') return 'tours';
  return parts[0].replace(/\.[^.]+$/, '') || 'root';
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return '';
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map(span => `{{expression}}${span.literal.text}`)].join('');
  }
  return null;
}

function propertyName(node) {
  if (!node.name) return '';
  if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text;
  return '';
}

function scanSource(filePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, filePath).replaceAll(path.sep, '/');
  if (ignoredPathPattern.test(relativePath)) return [];
  const source = fs.readFileSync(filePath, 'utf8');
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const candidates = [];

  function add(node, kind, rawText, context = '') {
    const text = normalizeText(rawText);
    if (!hasCopySignal(text)) return;
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    candidates.push({
      area: areaFor(relativePath),
      route_or_surface: context || path.basename(relativePath).replace(/\.(?:ts|tsx)$/, ''),
      source_file: `packages/frontend/src/${relativePath}`,
      line: start.line + 1,
      source_kind: kind,
      current_text: text,
      detected_language: detectLanguage(text),
      current_i18n_key: '',
      user_visible: kind === 'ui_object_property' ? 'needs_context' : 'yes',
      translation_policy: 'review',
      severity: sourceKindPriority(kind),
      status: 'candidate',
      ko_final: '',
      en_final: '',
      notes: context,
    });
  }

  function visit(node) {
    if (ts.isJsxText(node)) add(node, 'jsx_text', node.getText(sourceFile), 'JSX child');

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (visibleProps.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) add(node, 'visible_prop', node.initializer.text, name);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const text = literalText(node.initializer.expression);
          if (text !== null) add(node, 'visible_prop', text, name);
        }
      }
    }

    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const text = literalText(node.expression);
      if (text !== null) add(node, 'jsx_expression', text, 'JSX expression');
    }

    if (ts.isCallExpression(node) && visibleCalls.test(callName(node.expression))) {
      for (const argument of node.arguments.slice(0, 2)) {
        const text = literalText(argument);
        if (text !== null) add(argument, 'feedback_call', text, callName(node.expression));
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      if (!nonCopyAttributePattern.test(name) && /^(?:label|description|message|emptyText|tooltip|heading|subtitle|displayName|actionText|beforeTower|afterTower)$/i.test(name)) {
        const text = literalText(node.initializer);
        if (text !== null) add(node, 'ui_object_property', text, name);
      }
    }

    if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ts.isArrayLiteralExpression(node.parent)) {
      const collection = nearestVariableName(node);
      if (isUiCollectionName(collection)) add(node, 'ui_string_collection', node.text, collection);
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const text = literalText(node.expression);
      if (text !== null && !isFormattingOnlyReturn(text)) add(node, 'ui_return_literal', text, 'return');
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return candidates;
}

function flattenLocale(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flattenLocale(child, prefix ? `${prefix}.${key}` : key, output);
  } else output.set(prefix, value);
  return output;
}

function localeDiagnostics(sourceRoot) {
  const localeRoot = path.join(sourceRoot, 'locales');
  const languages = ['en', 'ko'];
  const byLanguage = Object.fromEntries(languages.map(language => [language, new Map()]));
  for (const language of languages) {
    for (const file of fs.readdirSync(path.join(localeRoot, language)).filter(name => name.endsWith('.json')).sort()) {
      const namespace = file.replace(/\.json$/, '');
      const values = flattenLocale(JSON.parse(fs.readFileSync(path.join(localeRoot, language, file), 'utf8')));
      for (const [key, value] of values) byLanguage[language].set(`${namespace}:${key}`, value);
    }
  }
  const allKeys = [...new Set([...byLanguage.en.keys(), ...byLanguage.ko.keys()])].sort();
  return {
    counts: Object.fromEntries(languages.map(language => [language, byLanguage[language].size])),
    missingEn: allKeys.filter(key => !byLanguage.en.has(key)),
    missingKo: allKeys.filter(key => !byLanguage.ko.has(key)),
    emptyEn: allKeys.filter(key => byLanguage.en.has(key) && normalizeText(String(byLanguage.en.get(key) ?? '')) === ''),
    emptyKo: allKeys.filter(key => byLanguage.ko.has(key) && normalizeText(String(byLanguage.ko.get(key) ?? '')) === ''),
  };
}

function csvEscape(value) {
  const string = String(value ?? '');
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function makeCsv(rows) {
  const columns = ['id', 'area', 'route_or_surface', 'source_file', 'line', 'source_kind', 'current_text', 'detected_language', 'current_i18n_key', 'user_visible', 'translation_policy', 'severity', 'status', 'ko_final', 'en_final', 'notes'];
  return [columns.join(','), ...rows.map(row => columns.map(column => csvEscape(row[column])).join(','))].join('\n') + '\n';
}

function makeSummary(rows, locale) {
  const countBy = key => Object.fromEntries([...rows.reduce((map, row) => map.set(row[key], (map.get(row[key]) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const renderCounts = counts => Object.entries(counts).map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| 없음 | 0 |';
  return `# Frontend Copy Inventory Summary\n\n- Generated: ${new Date().toISOString()}\n- Source root: \`packages/frontend/src\`\n- Candidate count: **${rows.length}**\n- Locale leaves: en **${locale.counts.en}**, ko **${locale.counts.ko}**\n- Missing locale keys: en **${locale.missingEn.length}**, ko **${locale.missingKo.length}**\n- Empty locale values: en **${locale.emptyEn.length}**, ko **${locale.emptyKo.length}**\n\n> 후보 수는 번역 대상 확정 수가 아니다. \`needs_context\`와 오탐을 사람이 검수해야 한다.\n\n## 후보 언어\n\n| 언어 | 수 |\n|---|---:|\n${renderCounts(countBy('detected_language'))}\n\n## 검출 종류\n\n| 종류 | 수 |\n|---|---:|\n${renderCounts(countBy('source_kind'))}\n\n## 상위 영역\n\n| 영역 | 수 |\n|---|---:|\n${renderCounts(Object.fromEntries(Object.entries(countBy('area')).slice(0, 25)))}\n\n## Locale 진단\n\n### 영어에 없는 키\n${locale.missingEn.length ? locale.missingEn.map(key => `- \`${key}\``).join('\n') : '- 없음'}\n\n### 한국어에 없는 키\n${locale.missingKo.length ? locale.missingKo.map(key => `- \`${key}\``).join('\n') : '- 없음'}\n`;
}

const files = walk(args.root).sort();
const rows = files.flatMap(file => scanSource(file, args.root))
  .sort((a, b) => a.source_file.localeCompare(b.source_file) || a.line - b.line || a.current_text.localeCompare(b.current_text))
  .map((row, index) => ({ id: `COPY-${String(index + 1).padStart(5, '0')}`, ...row }));
const locale = localeDiagnostics(args.root);
const csv = makeCsv(rows);
const summary = makeSummary(rows, locale);

if (!args.dryRun) {
  fs.mkdirSync(path.dirname(args.csv), { recursive: true });
  fs.mkdirSync(path.dirname(args.summary), { recursive: true });
  fs.writeFileSync(args.csv, csv);
  fs.writeFileSync(args.summary, summary);
}
console.log(JSON.stringify({ candidates: rows.length, filesScanned: files.length, locale, csv: args.csv, summary: args.summary, dryRun: args.dryRun }, null, 2));
