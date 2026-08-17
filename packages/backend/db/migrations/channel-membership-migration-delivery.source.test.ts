import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const start = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
const index = fs.readFileSync(path.join(root, 'packages/backend/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'packages/backend/db/migrations/125_channel_membership_provenance.sql'), 'utf8');

describe('channel membership migration delivery', () => {
  it('ships SQL migrations in normal and production builds', () => {
    expect(packageJson.scripts.build).toContain('cp -r packages/backend/db/migrations');
    expect(start).toContain('cp -r packages/backend/db/migrations dist-new/backend/packages/backend/db/migrations');
  });

  it('runs pending migrations automatically at backend startup', () => {
    expect(index).toContain('await initPg()');
  });

  it('keeps migration 125 idempotent for heterogeneous self-hosted servers', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS invited_by');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS membership_source');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS room_membership_events');
    expect(migration).toContain('WHERE NOT EXISTS');
  });
});
