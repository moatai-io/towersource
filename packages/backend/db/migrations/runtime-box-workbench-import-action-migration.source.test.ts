import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = path.resolve(import.meta.dirname);
const source = fs.readFileSync(path.join(migrations, '154_runtime_box_workbench_import_action.sql'), 'utf8');

describe('Workbench controlled legacy import action migration', () => {
  it('replaces the command action constraint without rewriting the original ledger migration', () => {
    expect(source).toContain('DROP CONSTRAINT IF EXISTS runtime_box_workbench_tool_commands_action_kind_check');
    expect(source).toContain('ADD CONSTRAINT runtime_box_workbench_tool_commands_action_kind_check');
    expect(source).toContain("action_kind IN ('install', 'rollback', 'import-project-prefix')");
  });

  it('follows the Runtime recreate intent migration', () => {
    expect(fs.existsSync(path.join(migrations, '153_runtime_box_workbench_runtime_recreate_intents.sql'))).toBe(true);
  });
});
