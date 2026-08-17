import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = path.resolve(import.meta.dirname);
const recreate = fs.readFileSync(path.join(migrations, '153_runtime_box_workbench_runtime_recreate_intents.sql'), 'utf8');

describe('Workbench Runtime recreate intent migration', () => {
  it('follows the A4a Workbench migrations without colliding with Activity work', () => {
    expect(fs.existsSync(path.join(migrations, '150_runtime_box_workbench_tool_revisions.sql'))).toBe(true);
    expect(fs.existsSync(path.join(migrations, '151_runtime_box_workbench_tool_commands.sql'))).toBe(true);
    expect(fs.existsSync(path.join(migrations, '152_runtime_box_workbench_tool_store_refs.sql'))).toBe(true);
    expect(recreate).toContain('runtime_box_workbench_runtime_recreate_intents');
    expect(recreate).not.toMatch(/activity_lease|activity_observation/i);
  });

  it('stores short-lived one-time audit state without a recovery journal authority', () => {
    expect(recreate).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(recreate).toContain('consumed_at TIMESTAMPTZ');
    expect(recreate).toContain("CHECK (status IN ('previewed','applying','succeeded','failed','recovery_required'))");
    expect(recreate).not.toMatch(/journal|operation_id|filesystem|backup|restore/i);
  });
});
