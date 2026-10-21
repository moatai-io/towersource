import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const selector = readFileSync(new URL('./SessionReasoningSelector.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('./StatusLine.tsx', import.meta.url), 'utf8');
const modelSelector = readFileSync(new URL('../layout/ModelSelector.tsx', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../../hooks/useChatRuntime.ts', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../admin/AdminPanel.tsx', import.meta.url), 'utf8');

describe('reasoning effort settings', () => {
  it('lets operators edit VM model defaults in the admin panel', () => {
    expect(panel).toContain("canEditReasoning={role === 'admin' || role === 'operator'}");
  });

  it('places the session selector inside the model menu and persists an override', () => {
    expect(modelSelector).toContain('<SessionReasoningSelector variant="model-menu" onComplete={() => setOpen(false)} />');
    expect(modelSelector).not.toContain('const decision = pick(modelId);\n    setOpen(false);');
    expect(modelSelector.indexOf('visibleLocalModels.map(renderModel)')).toBeLessThan(modelSelector.indexOf('<SessionReasoningSelector variant="model-menu"'));
    expect(status).not.toContain('SessionReasoningSelector');
    expect(selector).toContain("variant?: 'inline' | 'model-menu'");
    expect(selector).toContain("t('sessionReasoningDescription')");
    expect(selector).toContain('model.id === modelId)?.reasoningEfforts ?? []');
    expect(selector).toContain('if (efforts.length === 0) return null');
    expect(selector).toContain('<option value="">{t(\'reasoningDefault\')}</option>');
    expect(selector).toContain("method: 'PATCH'");
    expect(selector).toContain('body: JSON.stringify({ reasoningEffort })');
    expect(runtime).toContain('effort: currentSession?.reasoningEffort ?? undefined');
  });
});
