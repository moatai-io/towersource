import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migrationDir = path.join(root, 'packages/backend/db/migrations');
const migrationFiles = fs.readdirSync(migrationDir).filter(file => file.endsWith('.sql'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const preflight = fs.readFileSync(path.join(root, 'packages/backend/scripts/legacy-customer-mapping-retirement-preflight.ts'), 'utf8');

describe('legacy customer mapping retirement sequencing', () => {
  it('does not ship an automatic DROP in the same release as migration 191', () => {
    const droppers = migrationFiles.filter(file => fs.readFileSync(path.join(migrationDir, file), 'utf8').includes('DROP TABLE user_customer_vms'));
    expect(droppers).toEqual([]);
  });

  it('exposes a read-only fail-closed preflight with explicit confirmations', () => {
    expect(packageJson.scripts['preflight:legacy-customer-mappings']).toContain('legacy-customer-mapping-retirement-preflight.ts');
    expect(preflight).toContain("--confirm-compatibility-release");
    expect(preflight).toContain("--confirm-mapping-archive");
    expect(preflight).not.toMatch(/\b(?:DELETE|UPDATE|INSERT|DROP|ALTER|TRUNCATE)\b/);
  });
});
