import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = fs.readFileSync(new URL('./agent-purge-preview.ts', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../frontend/src/components/admin/AdminPanel.tsx', import.meta.url), 'utf8');

describe('Agent purge preview source contract', () => {
  it('is read-only and requires retirement before future apply', () => {
    const start = service.indexOf('export async function previewAgentPurge');
    const body = service.slice(start);
    expect(body).toContain('ACTIVE_AGENT_MUST_BE_RETIRED_FIRST');
    expect(body).toContain('SHARED_CREDENTIAL_REFERENCE');
    expect(body).not.toContain('DELETE FROM');
    expect(body).not.toContain('rmSync');
  });

  it('protects admin APIs with the admin/operator role boundary', () => {
    expect(api).toContain("router.get('/admin/agents'");
    expect(api).toContain("router.post('/admin/agents/:id/purge/preview'");
    expect(api.match(/if \(!isAdminOrOperator\(.*?role/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('shows both admin and operator the lifecycle tab without an apply action', () => {
    expect(ui).toContain("'agents'");
    expect(ui).toContain("new Set(['users', 'agents', 'usage', 'ai', 'credentials', 'system'])");
    expect(ui).toContain("t('permanentDeleteImpact')");
    expect(ui).toContain("t('permanentDeletionImpact')");
    expect(ui).toContain("t('confirmAgentNamePrefix')");
    expect(ui).toContain('/purge/apply');
  });
});
