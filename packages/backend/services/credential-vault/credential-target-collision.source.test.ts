import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('Runtime credential target collision contract', () => {
  it('prefers Agent-dedicated credentials before shared credentials', () => {
    expect(source).toContain("ORDER BY CASE c.scope WHEN 'project' THEN 0 ELSE 1 END, c.id");
    expect(source).toContain("duplicate target env; Agent-dedicated credential selected first");
    expect(source).not.toContain('project_credential_policies');
  });
});
