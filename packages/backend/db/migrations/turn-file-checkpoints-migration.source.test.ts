import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './158_turn_file_checkpoints.sql'), 'utf8');

describe('turn file checkpoint migration', () => {
  it('stores one checkpoint per root turn and first-before/last-after blobs', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS turn_checkpoints');
    expect(sql).toContain('UNIQUE (root_turn_id)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS checkpoint_file_changes');
    expect(sql).toContain('before_content BYTEA');
    expect(sql).toContain('after_content BYTEA');
    expect(sql).toContain('UNIQUE (checkpoint_id, file_path)');
  });

  it('keeps restore attempts append-only with preview and conflict evidence', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS checkpoint_restore_runs');
    expect(sql).toContain("status IN ('previewed', 'applied', 'conflict', 'failed')");
    expect(sql).toContain('preview_hash TEXT NOT NULL');
    expect(sql).toContain("selected_paths JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain("conflicts JSONB NOT NULL DEFAULT '[]'::jsonb");
  });
});
