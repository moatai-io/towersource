import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AutomationWorkbenchModal.tsx', import.meta.url), 'utf8');

describe('Automation Workbench revision intent UX', () => {
  it('creates and applies change intents instead of calling direct apply-yaml', () => {
    expect(source).toContain('const createChangeIntent = async () =>');
    expect(source).toContain('const applyChangeIntent = async () =>');
    expect(source).toContain('`${API}/${a.id}/change-intents`');
    expect(source).toContain('`${API}/${a.id}/change-intents/${changeIntent.id}/apply`');
    expect(source).not.toContain('`${API}/${a.id}/apply-yaml`');
  });

  it('shows risk, exact proposal hash, expiry, warnings, and explicit confirmation', () => {
    expect(source).toContain('검토 해시: {changeIntent.proposalHash}');
    expect(source).toContain('위험도 {changeIntent.riskLevel}');
    expect(source).toContain("title: highRisk ? '고위험 자동화 변경 적용'");
    expect(source).toContain('confirmedHighRisk: highRisk');
  });

  it('loads diagnostics and reconciles applying intents without retrying the mutation', () => {
    expect(source).toContain('change-intents/diagnostics');
    expect(source).toContain("intent.status === 'applying'");
    expect(source).toContain('const reconcileChangeIntent = async');
    expect(source).toContain('change-intents/${intent.id}/reconcile');
    expect(source).toContain('변경을 다시 실행하지는 않습니다');
  });
});
