import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 2A — No duplicate type definitions.
 * After migration, SessionMeta etc. must only be defined in @tower/shared.
 * Extended types (e.g., `interface ProjectRow extends Project`) are allowed.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

/** Scan a directory recursively for .ts/.tsx files */
function scanDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...scanDir(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

const SHARED_TYPES = [
  'SessionMeta',
  'TaskMeta',
  'WorkflowMode',
  'Project',
  'Pin',
  'PromptItem',
  'FileEntry',
  'GitCommitInfo',
];

// Regex to detect standalone interface/type definitions (not extensions)
function makeDefinitionRegex(name: string): RegExp {
  // Match: export interface Name { or export type Name = or interface Name {
  // But NOT: interface FooRow extends Name
  return new RegExp(
    `^\\s*export\\s+(interface|type)\\s+${name}\\s*[\\{=]`,
    'm',
  );
}

describe('no duplicate type definitions', () => {
  const frontendFiles = scanDir(path.join(ROOT, 'frontend', 'src'));
  const backendFiles = scanDir(path.join(ROOT, 'backend'));

  for (const typeName of SHARED_TYPES) {
    it(`${typeName}이 frontend/backend에 독립 정의되지 않음`, () => {
      const regex = makeDefinitionRegex(typeName);
      const duplicates: string[] = [];

      for (const file of [...frontendFiles, ...backendFiles]) {
        const content = fs.readFileSync(file, 'utf-8');
        if (regex.test(content)) {
          duplicates.push(path.relative(ROOT, file));
        }
      }

      expect(
        duplicates,
        `${typeName} found in: ${duplicates.join(', ')}. Should only be in @tower/shared.`,
      ).toHaveLength(0);
    });
  }
});
