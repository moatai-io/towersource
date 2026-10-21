import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const activeSources = [
  'packages/backend/services',
  'packages/backend/routes',
  'packages/backend/mcp',
  'packages/backend/engines',
  'packages/frontend/src',
];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.|\.source\.test\.|\.e2e\.test\.|\.integration\.test\./.test(entry.name) ? [relative] : [];
  });
}

describe('legacy user_customer_vms retirement precondition', () => {
  it('has no active backend or frontend code dependency before a later DROP migration', () => {
    const references = activeSources.flatMap(sourceFiles).filter(file => fs.readFileSync(path.join(root, file), 'utf8').includes('user_customer_vms'));
    expect(references).toEqual([]);
  });

  it('keeps the compatibility table until a release boundary is explicitly verified', () => {
    const migration = fs.readFileSync(path.join(root, 'packages/backend/db/migrations/191_remove_customer_manager_role.sql'), 'utf8');
    expect(migration).toContain('intentionally retained for one compatibility release');
    expect(migration).not.toContain('DROP TABLE user_customer_vms');
  });
});
