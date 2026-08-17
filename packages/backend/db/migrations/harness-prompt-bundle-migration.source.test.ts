import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './129_harness_prompt_bundle_fingerprint.sql'), 'utf8');

describe('Harness Prompt Bundle fingerprint migration', () => {
  it('adds a nullable replay-safe snapshot identity column', () => {
    expect(source).toContain('ADD COLUMN IF NOT EXISTS prompt_bundle_hash TEXT');
    expect(source).toContain('WHERE prompt_bundle_hash IS NOT NULL');
  });

  it('leaves historical snapshot JSON immutable for runtime lazy identity backfill', () => {
    expect(source).not.toMatch(/UPDATE\s+session_runtime_snapshots/i);
    expect(source).toContain('does not rewrite');
  });
});
