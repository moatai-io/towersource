import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(import.meta.dirname, '199_legacy_gws_runtime_bindings_schema_repair.sql'), 'utf8');
const backfill = fs.readFileSync(path.resolve(import.meta.dirname, '200_disable_unreviewed_legacy_gws_runtime_bindings.sql'), 'utf8');

describe('legacy GWS runtime binding schema repair migration', () => {
  it('adds the missing bundle identity columns without rewriting migration 197', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS bundle_sha256 TEXT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS credential_path TEXT');
    expect(migration).toContain("bundle_sha256 ~ '^[a-f0-9]{64}$'");
    expect(migration).toContain("credential_path ~ '^(users/[0-9]+/)?credentials[.]json$'");
  });

  it('separates the historical row backfill from the schema transaction and fails closed', () => {
    expect(migration).not.toContain('UPDATE legacy_gws_runtime_bindings');
    expect(backfill).toMatch(/UPDATE legacy_gws_runtime_bindings[\s\S]*SET enabled = false[\s\S]*bundle_sha256 IS NULL OR credential_path IS NULL/);
    expect(`${migration}\n${backfill}`).not.toContain('DROP TABLE');
    expect(`${migration}\n${backfill}`).not.toContain('DELETE FROM legacy_gws_runtime_bindings');
  });
});
