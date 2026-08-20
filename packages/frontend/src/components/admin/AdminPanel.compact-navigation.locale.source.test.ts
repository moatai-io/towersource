import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AdminPanel.tsx'), 'utf8');
const locale = (language: 'en' | 'ko') => JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, `../../locales/${language}/admin.json`), 'utf8'),
);

describe('Admin Panel compact navigation contract', () => {
  it('uses dedicated short labels for top-level and connection detail tabs', () => {
    for (const key of ['users', 'agents', 'usage', 'ai', 'runtime', 'connections', 'system']) {
      expect(source).toContain(`t('navigation.${key}')`);
    }
    for (const key of ['management', 'agents', 'advanced']) {
      expect(source).toContain(`t('credentialConnections.detailTabs.${key}')`);
    }
    expect(source).not.toContain("renderTab('agents', t('agentManagement'))");
    expect(source).not.toContain("['management', t('credentialConnections.managementTab')]");
  });

  it('keeps navigation labels within compact copy budgets', () => {
    for (const language of ['en', 'ko'] as const) {
      const admin = locale(language);
      for (const value of Object.values(admin.navigation) as string[]) {
        expect(value.length).toBeLessThanOrEqual(12);
      }
      for (const value of Object.values(admin.credentialConnections.detailTabs) as string[]) {
        expect(value.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('keeps connection action labels within button copy budgets', () => {
    for (const language of ['en', 'ko'] as const) {
      const labels = locale(language).credentialConnections.actionLabels;
      for (const value of Object.values(labels) as string[]) {
        expect(value.length).toBeLessThanOrEqual(14);
      }
    }
    expect(source).toContain("t('credentialConnections.actionLabels.connect')");
    expect(source).toContain("t('credentialConnections.actionLabels.copyPrompt')");
    expect(source).toContain("title={t('credentialConnections.copyDiagnosticPrompt')}");
  });

  it('keeps advanced credential actions within compact copy budgets', () => {
    for (const language of ['en', 'ko'] as const) {
      const labels = locale(language).credentialConnections.advancedActions;
      for (const value of Object.values(labels) as string[]) {
        expect(value.length).toBeLessThanOrEqual(16);
      }
    }
    expect(source).toContain("t('credentialConnections.advancedActions.reveal')");
    expect(source).toContain("t('credentialConnections.advancedActions.reviewAndReplace')");
    expect(source).not.toContain('>원문 보기</button>');
    expect(source).not.toContain('>영향 확인 후 교체</button>');
  });

  it('keeps tabs and connection actions responsive on narrow screens', () => {
    expect(source).toContain('shrink-0 whitespace-nowrap px-3 py-2');
    expect(source).toContain('flex shrink-0 overflow-x-auto');
    expect(source).toContain('px-2 sm:px-6');
    expect(source).toContain('grid w-full grid-cols-2 gap-2 lg:flex');
    expect(source).toContain('grid w-full grid-cols-2 gap-2 sm:flex');
    expect(source).toContain('min-h-10 flex-1');
    expect(source).toContain('mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap');
    expect(source).toContain('mt-3 min-h-10 w-full');
  });
});
