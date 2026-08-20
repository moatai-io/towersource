import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');
const api = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/workbench-worker-api.ts'), 'utf8');

describe('Admin Project Workstation change UX', () => {
  it('requires preview, server smoke, and receipt-backed apply in order', () => {
    expect(source).toContain('/workstation-change/preview');
    expect(source).toContain('/workstation-change/smoke');
    expect(source).toContain('/workstation-change/apply');
    expect(source).toContain('smokeReceiptHash: smokeReceipt.receiptHash');
    expect(source).not.toContain('smokePassed: true');
    expect(api).toContain('smokeReceiptHash: z.string().regex');
  });

  it('shows current and target Worker state without a free-form Worker id field', () => {
    expect(source).toContain('agent.workstation.workerId');
    expect(source).toContain('workers.filter(worker => worker.deploymentId === \'production\'');
    expect(source).toContain("t('agentLifecycle.previewSummary'");
    expect(source).toContain("t('agentLifecycle.verificationPassed')");
    expect(source).not.toContain('placeholder="Worker ID"');
  });
});
