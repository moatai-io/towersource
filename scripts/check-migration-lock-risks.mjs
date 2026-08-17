#!/usr/bin/env node
/**
 * Fail preflight when one SQL migration combines lock-sensitive DDL with a
 * potentially long table rewrite/backfill or index build.
 *
 * Escape hatch: add `tower:migration-lock-risk-reviewed` to the SQL file only
 * after an explicit production-lock review. Prefer splitting into ordered
 * migration files because the runner commits each file independently.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'packages/backend/db/migrations');
const REVIEW_MARKER = 'tower:migration-lock-risk-reviewed';

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function detectRisks(sql) {
  const source = stripSqlComments(sql);
  const lockSensitiveDdl = /\bALTER\s+TABLE\b/i.test(source);
  const broadUpdate = /\bUPDATE\s+(?:ONLY\s+)?(?:"?[\w.]+"?)\b[\s\S]*?\bSET\b/i.test(source);
  const indexBuild = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(source);
  const findings = [];
  if (lockSensitiveDdl && broadUpdate) findings.push('ALTER TABLE + UPDATE/backfill');
  if (lockSensitiveDdl && indexBuild) findings.push('ALTER TABLE + CREATE INDEX');
  if (broadUpdate && indexBuild) findings.push('UPDATE/backfill + CREATE INDEX');
  return findings;
}

const violations = [];
const requestedFiles = process.argv.slice(2);
const entries = requestedFiles.length > 0
  ? requestedFiles.map((file) => ({ name: path.basename(file), file: path.resolve(ROOT, file) }))
  : (await fs.readdir(MIGRATIONS, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      // Existing migrations are immutable historical records. The guard starts
      // after incident migration 159 and applies to every new numbered file.
      .filter((entry) => Number.parseInt(entry.name.match(/^(\d+)/)?.[1] || '0', 10) >= 160)
      .map((entry) => ({ name: entry.name, file: path.join(MIGRATIONS, entry.name) }));
for (const entry of entries) {
  if (!entry.name.endsWith('.sql')) continue;
  const file = entry.file;
  const sql = await fs.readFile(file, 'utf8');
  const findings = detectRisks(sql);
  if (findings.length > 0 && !sql.includes(REVIEW_MARKER)) {
    violations.push({ file: path.relative(ROOT, file), findings });
  }
}

if (violations.length > 0) {
  console.error('❌ Migration lock-risk guard failed.\n');
  for (const violation of violations) {
    console.error(`  ${violation.file}`);
    for (const finding of violation.findings) console.error(`    - ${finding}`);
  }
  console.error('\nSplit schema change, backfill, constraint finalization, and index build into separate files/transactions.');
  console.error(`Only after an explicit production-lock review may the SQL contain: ${REVIEW_MARKER}`);
  process.exit(1);
}

console.log('✓ Migration lock-risk contracts clean');
