import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../scripts/fleet/fleet-deploy-fast', import.meta.url), 'utf8');

describe('Fleet exact-revision migration approval reuse', () => {
  it('reuses approval only when Operator Prod already runs the exact migration revision', () => {
    expect(source).toContain("x.get('dbMigrationRequired') and x.get('operatorMatchesTarget')");
    expect(source).toContain('args+=(--approve-db-migrations "$approved")');
  });

  it('keeps explicit migration approval when supplied', () => {
    expect(source).toContain('elif [[');
    expect(source).toContain('if [[ -n "$migration" ]]');
    expect(source).toContain('args+=(--approve-db-migrations "$migration")');
  });
});
