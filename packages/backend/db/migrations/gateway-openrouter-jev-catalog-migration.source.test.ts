import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/214_gateway_openrouter_jev_catalog.sql'), 'utf8');

describe('OpenRouter Jev Gateway catalog migration', () => {
  it('registers the Decisions route without storing credentials', () => {
    expect(sql).toContain("'openrouter-jev'");
    expect(sql).toContain("'/inference/openrouter'");
    expect(sql).toContain("'decision_evaluation'");
    expect(sql).toContain("'tokens'");
    expect(sql).toContain('typesafe/jev-1.13');
    expect(sql).not.toMatch(/api[_-]?key|secret_value|credential_id/i);
  });
});
