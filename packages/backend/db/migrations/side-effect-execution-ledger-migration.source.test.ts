import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './137_side_effect_execution_ledger.sql'), 'utf8');

describe('side effect execution ledger migration', () => {
  it('stores operation, semantic identity, terminal result and uncertain state', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS side_effect_executions');
    expect(sql).toContain("status IN ('running', 'succeeded', 'uncertain')");
    expect(sql).toContain('owner_token TEXT NOT NULL');
    expect(sql).toContain('result_json JSONB');
    expect(sql).toContain('root_turn_id, operation_id');
    expect(sql).toContain('root_turn_id, tool_name, semantic_hash');
  });
});
