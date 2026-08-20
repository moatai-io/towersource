import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));

describe('Admin AI operations information architecture', () => {
  it('leads with status and workload-based model policy', () => {
    expect(source).toContain("t('aiStatusTitle')");
    expect(source).toContain("t('modelPolicyTitle')");
    expect(source).toContain("t('primaryWorkModel')");
    expect(source).toContain("t('utilityWorkModel')");
    expect(source).toContain("t('backgroundWorkModel')");
  });

  it('keeps composer and legacy account controls progressively disclosed', () => {
    expect(source).toContain("t('legacyExecution')");
    expect(source).toContain('<details className="group border-t border-surface-800 pt-6">');
    expect(source).toContain('<AiComposerSettingsPanel token={token} />');
    expect(source).toContain('<ClaudeAccountManagement token={token} />');
  });

  it('shows policy references and protects models used by the default policy', () => {
    expect(source).toContain('const policyReferences = (modelId: string)');
    expect(source).toContain("Object.values(models.defaults ?? {}).includes(model.id)");
    expect(source).toContain("Object.values(models.defaults ?? {}).includes(modelId)");
    expect(source).toContain("t('defaultModelDisableBlocked')");
    expect(source).toContain("t('defaultModelDeleteBlocked')");
    expect(source).toContain('disabled={references.length > 0}');
  });

  it('uses accessible switch controls for model enablement', () => {
    expect(source).toContain('role="switch"');
    expect(source).toContain('aria-checked={m.enabled}');
    expect(source).toContain("aria-label={t('toggleModel', { name: m.name })}");
  });

  it('ships matching Korean and English operation labels', () => {
    const keys = [
      'aiOperationsTitle',
      'aiOperationsIntro',
      'aiStatusTitle',
      'modelPolicyTitle',
      'primaryWorkModel',
      'utilityWorkModel',
      'backgroundWorkModel',
      'connectionsAndAuth',
      'availableModels',
      'legacyExecution',
      'defaultModelDisableBlocked',
      'defaultModelDeleteBlocked',
      'toggleModel',
    ];
    for (const key of keys) {
      expect(ko[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });
});
