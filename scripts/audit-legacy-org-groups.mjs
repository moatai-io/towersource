#!/usr/bin/env node
/**
 * Audit that legacy organization groups do not re-enter runtime code.
 *
 * The DB tables `groups` and `user_groups` intentionally remain as compatibility
 * shells for stale builds/rollback targets, but product code must not expose
 * group CRUD APIs or query group membership for runtime context/access control.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = [
  'packages/backend/routes',
  'packages/backend/services',
  'packages/backend/scripts',
  'packages/frontend/src',
];

const ALLOW = new Set([
  // This audit script documents the forbidden patterns.
  path.normalize('scripts/audit-legacy-org-groups.mjs'),
]);

const FORBIDDEN = [
  /getUserGroups\b/,
  /inviteGroupToProject\b/,
  /listGroups\b/,
  /createGroup\b/,
  /addUserToGroup\b/,
  /removeUserFromGroup\b/,
  /\/admin\/groups\b/,
  /\/my\/groups\b/,
  /\bFROM\s+groups\b/i,
  /\bJOIN\s+user_groups\b/i,
  /`Groups:\s*\$\{/,
];

function walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
    const p = path.join(abs, ent.name);
    if (ent.isDirectory()) out.push(...walk(path.relative(ROOT, p)));
    else if (/\.(ts|tsx|js|jsx|mjs|sql|json)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of SCAN_DIRS.flatMap(walk)) {
  const rel = path.relative(ROOT, file);
  if (ALLOW.has(path.normalize(rel))) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rx of FORBIDDEN) {
      if (rx.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (hits.length) {
  console.error('Legacy organization group references found. Use project_members/project-membership-manager instead.');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

console.log('OK: no legacy organization group runtime references found.');
