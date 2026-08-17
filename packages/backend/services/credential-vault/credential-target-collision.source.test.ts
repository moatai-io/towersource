import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/credential-vault/credential-vault-service.ts'), 'utf8');

describe('Runtime credential target collision contract', () => {
  it('selects explicit override first and audits every duplicate target', () => {
    expect(source).toContain("ORDER BY CASE p.mode WHEN 'override' THEN 0 WHEN 'allow' THEN 1 WHEN 'inherit' THEN 2 ELSE 3 END, c.id");
    expect(source).toContain("eventType: 'materialize_skip_duplicate_target'");
    expect(source).toContain("errorCode: 'DUPLICATE_TARGET_ENV'");
    expect(source).toContain('higher-priority project Credential already owns this Runtime env target');
  });
});
