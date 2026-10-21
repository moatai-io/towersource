import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const modelSource = readFileSync(new URL('./model-management/ModelManagement.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));

describe('AI operations simplified settings', () => {
  it('shows two workload policies and the router identity to operators', () => {
    expect(source).toContain("'usage', 'ai', 'credentials'");
    expect(source).toContain("<AiSettingsManagement token={token} canEditReasoning={role === 'admin' || role === 'operator'} />");
    expect(modelSource).toContain("key: 'session' as const");
    expect(modelSource).toContain("key: 'ai_task' as const");
    expect(modelSource).not.toContain("key: 'ai_reply' as const");
    expect(modelSource).toContain("t('moatAiRouter')");
    expect(modelSource).toContain("t('routerKeyName')");
  });

  it('does not render obsolete composer, manual model registry, or legacy account panels', () => {
    expect(source).not.toContain('<AiComposerSettingsPanel');
    expect(source).not.toContain('<ClaudeAccountManagement');
    expect(source).not.toContain("t('piOpenRouter')");
    expect(source).not.toContain("t('claudeMax')");
    expect(modelSource).toContain("t('litellmCatalog')");
    expect(source).not.toContain('setCatalogModelSelectable');
    expect(modelSource).toContain('catalogModelIds.has(model.modelId)');
  });

  it('offers per-model reasoning defaults without changing workload policy effort', () => {
    expect(modelSource).toContain('/admin/models/reasoning');
    expect(modelSource).toContain("model.reasoning &&");
    expect(modelSource).toContain("model.defaultReasoning ?? 'medium'");
    expect(modelSource).toContain("model.reasoningEfforts?.length ? model.reasoningEfforts : ['low', 'medium', 'high']");
    expect(modelSource).toContain("'low' | 'medium' | 'high' | 'xhigh' | 'max'");
    expect(ko.modelReasoningTitle).toBeTruthy();
    expect(en.modelReasoningTitle).toBeTruthy();
  });

  it('labels the Core work slot and Lite utility slot without presenting Lite as automation', () => {
    expect(modelSource).toContain("{ key: 'session' as const, label: t('primaryWorkModel'), desc: t('sessionModelDesc') }");
    expect(modelSource).toContain("{ key: 'ai_task' as const, label: t('utilityWorkModel'), desc: t('aiReplyModelDesc') }");
    expect(modelSource).not.toContain("t('backgroundWorkModel')");
    expect(source).toContain("{ label: t('taskExecutionModel'), value: defaults.session || '-' }");
    expect(ko.primaryWorkModel).toContain('Core');
    expect(ko.utilityWorkModel).toContain('Lite');
    expect(ko.sessionModelDesc).toContain('자동화·예약 실행');
    expect(en.sessionModelDesc).toContain('automation');
    expect(ko.aiReplyModelDesc).toContain('기본 모델은 Core');
    expect(en.aiReplyModelDesc).toContain('default to Core');
  });

  it('ships matching locale labels', () => {
    for (const key of ['primaryWorkModel', 'utilityWorkModel', 'moatAiRouter', 'routerKeyName', 'routerKeyUnavailable']) {
      expect(ko[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });
});
