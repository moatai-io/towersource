import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './142_harness_staffing_capabilities.sql'), 'utf8');

describe('Harness staffing capabilities migration', () => {
  it('adds versioned role-fit metadata without changing runtime capabilityIds', () => {
    expect(source).toContain('ADD COLUMN IF NOT EXISTS staffing_capability_ids JSONB');
    expect(source).toContain('Not a runtime tool authority grant');
    expect(source).not.toMatch(/UPDATE\s+harness_versions[\s\S]*effective_manifest\s*=/i);
  });

  it('describes Tower Default full-surface staffing fit', () => {
    expect(source).toContain("harness_id='tower-default' AND version=1");
    expect(source).toContain('"public_web_research"');
    expect(source).toContain('"project_file_write"');
    expect(source).toContain('"code_edit"');
    expect(source).toContain('"web_build"');
    expect(source).toContain('"static_site_preview"');
  });

  it('keeps Quick Web Research narrowly described', () => {
    expect(source).toContain("harness_id='quick-web-research' AND version=1");
    expect(source).toContain("'[\"public_web_research\"]'::jsonb");
  });
});
