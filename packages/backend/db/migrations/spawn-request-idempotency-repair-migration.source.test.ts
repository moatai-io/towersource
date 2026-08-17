import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const original = fs.readFileSync(path.resolve(import.meta.dirname, './135_spawn_request_idempotency.sql'), 'utf8');
const repair = fs.readFileSync(path.resolve(import.meta.dirname, './141_spawn_request_idempotency_repair.sql'), 'utf8');

describe('spawn request idempotency repair migration', () => {
  it('ships an append-only migration after the already-recorded 135 migration', () => {
    expect(repair).toContain('Repair fleets that applied the initial form of migration 135');
    expect(repair).not.toBe(original);
  });

  it('idempotently repairs all required columns', () => {
    expect(repair).toContain('ADD COLUMN IF NOT EXISTS request_fingerprint TEXT');
    expect(repair).toContain('ADD COLUMN IF NOT EXISTS root_turn_id TEXT');
    expect(repair).toContain('ADD COLUMN IF NOT EXISTS operation_id TEXT');
  });

  it('idempotently repairs the parent-scoped operation and lookup indexes', () => {
    expect(repair).toContain('CREATE INDEX IF NOT EXISTS idx_spawn_callbacks_request_fingerprint');
    expect(repair).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_spawn_callbacks_operation_id');
    expect(repair).toContain('ON spawn_callbacks(parent_session_id, operation_id)');
    expect(repair).toContain('CREATE INDEX IF NOT EXISTS idx_spawn_callbacks_root_turn');
    expect(repair).toContain('ON spawn_callbacks(root_turn_id, registered_at DESC)');
  });
});
