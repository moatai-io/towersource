import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/211_gateway_profiles.sql'), 'utf8');

describe('Gateway Profile control-plane migration', () => {
  it('creates a secret-free profile and catalog without reviving credential_profiles', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gateway_profiles');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gateway_profile_catalog_entries');
    expect(sql).toContain('credential_id TEXT REFERENCES workspace_credentials(id)');
    expect(sql).not.toMatch(/secret_value|secret_refs|CREATE TABLE IF NOT EXISTS credential_profiles/i);
  });

  it('seeds the five shared APIs in observe mode', () => {
    for (const api of ['firecrawl', 'apify', 'naver', 'openai', 'agent-store']) expect(sql).toContain(`'${api}'`);
    expect(sql).toContain("quota_mode TEXT NOT NULL DEFAULT 'observe'");
    expect(sql).toContain("'tower-shared-api-v1'");
  });
});
