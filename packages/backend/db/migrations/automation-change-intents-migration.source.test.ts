import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/145_automation_change_intents.sql'), 'utf8');

describe('automation change intents migration', () => {
  it('stores revision-bound one-time proposals and apply provenance', () => {
    expect(sql).toContain('automation_change_intents');
    expect(sql).toContain('base_config_updated_at');
    expect(sql).toContain('applying_by_user_id');
    expect(sql).toContain('applying_at');
    expect(sql).toContain('proposal_hash');
    expect(sql).toContain('materialized_updates');
    expect(sql).toContain("'proposed','applying','applied','rejected','expired','failed'");
    expect(sql).toContain('applied_by_user_id');
    expect(sql).toContain('expires_at');
  });
});
