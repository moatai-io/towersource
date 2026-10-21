import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AutomationWorkbenchModal.tsx', import.meta.url), 'utf8');
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/automation.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../../locales/en/automation.json', import.meta.url), 'utf8'));

describe('Automation Workbench execution preview retirement', () => {
  it('has no UI requests to either side-effecting dry-run endpoint', () => {
    expect(source).not.toContain('/full-dry-run');
    expect(source).not.toContain('/observe-dry-run');
    expect(source).not.toContain('runFullPreview');
    expect(source).not.toContain('runObserve');
    expect(source).toContain("t('previewFlowDescription')");
  });

  it('warns in both locales that the former preview executed stored work', () => {
    expect(ko.previewFlowDescription).toContain('실제 실행');
    expect(en.previewFlowDescription).toContain('actually execute');
  });

  it('does not present conditional AI/reporting as a ready-to-enable conversation example', () => {
    expect(ko.exampleConditions).toContain('지원하지 않는');
    expect(en.exampleConditions).toContain('not supported');
    expect(ko.exampleQuiet).toContain('30분마다');
    expect(en.exampleQuiet).toContain('30-minute interval');
    expect(ko.exampleQuiet).not.toContain('오전 9시');
    expect(en.exampleQuiet).not.toContain('9:00');
  });
});
