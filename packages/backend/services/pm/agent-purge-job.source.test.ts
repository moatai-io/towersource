import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const job = fs.readFileSync(new URL('./agent-purge-job.ts', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../frontend/src/components/admin/AdminPanel.tsx', import.meta.url), 'utf8');

describe('durable Agent purge source contract', () => {
  it('requires exact preview, retirement, typed name and explicit confirmation', () => {
    expect(job).toContain('EXPLICIT_CONFIRMATION_REQUIRED');
    expect(job).toContain('VALID_UNUSED_PREVIEW_REQUIRED');
    expect(job).toContain('AGENT_MUST_BE_RETIRED');
    expect(job).toContain('TYPED_AGENT_NAME_MISMATCH');
    expect(job).toContain('PURGE_PREVIEW_HAS_BLOCKERS');
  });

  it('quarantines inside workspace and protects shared secrets', () => {
    expect(job).toContain("path.resolve(config.workspaceRoot, '.agent-purge-quarantine')");
    expect(job).toContain('PROJECT_PATH_OUTSIDE_MANAGED_ROOT');
    expect(job).toContain('fs.renameSync(source, quarantinePath)');
    expect(job).toContain('SHARED_SECRET_NAME');
    expect(job).toContain('NOT EXISTS (SELECT 1 FROM workspace_credentials');
  });

  it('records retryable pre/post destructive outcomes', () => {
    expect(job).toContain("'failed_before_destructive'");
    expect(job).toContain("'recovery_required'");
    expect(job).toContain("status IN ('approved','failed_before_destructive','recovery_required')");
    expect(api).toContain("router.post('/admin/agent-purge-jobs/:jobId/retry'");
    expect(api).toContain("router.get('/admin/agent-purge-jobs/:jobId'");
  });

  it('exposes destructive apply only behind typed-name UI confirmation', () => {
    expect(api).toContain("router.post('/admin/agents/:id/purge/apply'");
    expect(ui).toContain('typedName !== preview.impact.projectName');
    expect(ui).toContain('purgeConfirmed');
    expect(ui).toContain('영구 삭제 작업 시작');
  });
});
