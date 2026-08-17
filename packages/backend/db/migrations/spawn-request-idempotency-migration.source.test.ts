import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './135_spawn_request_idempotency.sql'), 'utf8');

describe('spawn request idempotency migration', () => {
  it('adds a restart-safe parent-scoped request lookup', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS request_fingerprint TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS root_turn_id TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS operation_id TEXT');
    expect(sql).toContain('parent_session_id, request_fingerprint, registered_at DESC');
    expect(sql).toContain('parent_session_id, operation_id');
    expect(sql).toContain('UNIQUE INDEX');
  });
});
