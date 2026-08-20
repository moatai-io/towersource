import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin legacy UI cleanup', () => {
  it('shows only connection methods with implemented completion paths', () => {
    expect(source).not.toContain("| 'cloud'");
    expect(source).not.toContain("| 'cli'");
    expect(source).not.toContain("mode: 'cloud'");
    expect(source).not.toContain("mode: 'cli'");
    expect(source).not.toContain('이 타입은 아직 저장 동작 전 단계입니다.');
    expect(source).toContain("mode: 'api_key_simple'");
    expect(source).toContain("mode: 'oauth'");
    expect(source).toContain("mode: 'ssh'");
  });

  it('removes the unused legacy AI usage wrapper and dashboard', () => {
    expect(source).not.toContain('function AiUsageManagement');
    expect(source).not.toContain('function AiTokenUsageDashboard');
    expect(source).not.toContain('interface AiTokenBudgetSnapshot');
    expect(source).toContain('<UsagePanel embedded />');
  });
});
