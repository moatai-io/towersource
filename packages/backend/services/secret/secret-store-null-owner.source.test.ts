import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(process.cwd(), 'packages/backend/services/secret/secret-store.ts'), 'utf8');

describe('secret-store nullable owner rotation contract', () => {
  it('serializes one logical secret identity and matches nullable owners null-safely', () => {
    expect(source).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(source).toContain('owner_user_id IS NOT DISTINCT FROM $3');
    expect(source).toContain('owner_tool_id IS NOT DISTINCT FROM $4');
    expect(source).not.toContain('ON CONFLICT (name, scope, owner_user_id, owner_tool_id)');
  });

  it('updates every historical duplicate and returns the oldest stable identity', () => {
    expect(source).toMatch(/UPDATE secret_store[\s\S]*RETURNING id/);
    expect(source).toContain('Math.min(...updated.rows.map(row => row.id))');
    expect(source).toMatch(/if \(updated\.rows\.length > 0\)[\s\S]*else \{[\s\S]*INSERT INTO secret_store/);
  });

  it('keeps the null-safe upsert inside one transaction with rollback and release', () => {
    expect(source).toContain("await client.query('BEGIN')");
    expect(source).toContain("await client.query('COMMIT')");
    expect(source).toContain("await client.query('ROLLBACK').catch(() => undefined)");
    expect(source).toContain('client.release()');
  });
});
