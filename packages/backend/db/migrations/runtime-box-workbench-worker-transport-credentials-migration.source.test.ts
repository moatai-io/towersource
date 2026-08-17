import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./172_runtime_box_workbench_worker_transport_credentials.sql', import.meta.url), 'utf8');

describe('Workbench Worker transport credential migration', () => {
  it('stores only a Secret Store reference and no bearer material', () => {
    expect(source).toContain('runtime_box_workbench_worker_transport_credentials');
    expect(source).toContain('secret_name TEXT NOT NULL');
    expect(source).toContain('REFERENCES runtime_box_workbench_workers');
    expect(source).not.toMatch(/token_value|bearer_token|value_encrypted|raw_secret/i);
  });
});
