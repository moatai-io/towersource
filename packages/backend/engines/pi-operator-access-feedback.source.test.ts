import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const assembly = readFileSync(new URL('./pi/tool-assembly.ts', import.meta.url), 'utf8');
const api = readFileSync(new URL('../routes/api.ts', import.meta.url), 'utf8');
describe('Operator access feedback', () => {
  it('identifies the backend host without promising unrestricted access', () => {
    expect(assembly).toContain('Operator access is enabled:');
    expect(assembly).toContain('Existing file, credential, and approval guards still apply');
    expect(assembly).toContain('not on the Project Worker');
  });
  it('logs explicit persisted assignments without claiming a transition', () => {
    const audit = api.indexOf("console.info('[operator-access-audit]'");
    expect(audit).toBeGreaterThan(api.indexOf('const superuser = profile.superuser === true'));
    expect(api.slice(audit, audit + 420)).toContain("event: 'operator_access_assigned'");
    expect(api.slice(audit, audit + 420)).toContain('actorUserId: userId');
    expect(api.slice(audit, audit + 420)).not.toContain('JSON.stringify(profile)');
  });
});
