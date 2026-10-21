import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './HtmlPreviewSurface.tsx'), 'utf8');

describe('HtmlPreviewSurface chat-centered source edit contract', () => {
  it('attaches the trusted source chip immediately when an element is selected', () => {
    const selectionIndex = source.indexOf("data.type !== 'tower-html-source-select'");
    const dispatchIndex = source.indexOf('dispatchComposerSourceReference({', selectionIndex);
    expect(selectionIndex).toBeGreaterThan(0);
    expect(dispatchIndex).toBeGreaterThan(selectionIndex);
    expect(source).toContain("toastSuccess(t('htmlPreview.sourceAttached'");
  });

  it('does not expose the obsolete separate edit proposal modal', () => {
    expect(source).not.toContain('Edit only this element');
    expect(source).not.toContain('Generate exact-range diff');
    expect(source).not.toContain('Apply exact range');
    expect(source).not.toContain("fetch('/api/files/scoped-edit/propose'");
  });

  it('keeps an explicit attach-again action for replacing a dismissed chip', () => {
    expect(source).toContain("t('htmlPreview.attachAgain'");
  });

  it('preserves absolute inset sizing from the Viewer instead of overriding it with relative positioning', () => {
    expect(source).not.toContain("${className ?? 'absolute inset-0'} relative");
    expect(source).toContain("${className ?? 'absolute inset-0'} overflow-hidden");
  });
});
