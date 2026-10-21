import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'main.tsx'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, 'index.css'), 'utf8');

describe('mobile visual viewport ownership', () => {
  it('does not mutate a global viewport height variable from the application entry point', () => {
    expect(source).not.toContain("setProperty('--vvh'");
    expect(source).not.toContain('setupVisualViewportTracking');
    expect(source).not.toContain('performance.now() - start < 450');
  });

  it('keeps only the editable focus presentation hook in the application entry point', () => {
    expect(source).toContain('setupEditableFocusState');
    expect(source).toContain("root.classList.add('tower-input-focused')");
    expect(source).toContain("root.classList.remove('tower-input-focused')");
  });

  it('keeps document roots stable instead of resizing all of them to a keyboard variable', () => {
    const mobileStability = css.slice(css.indexOf('/* ─── Mobile input stability ─── */'));
    expect(mobileStability).toContain('height: 100dvh');
    expect(mobileStability).not.toContain('height: var(--vvh');
    expect(mobileStability).not.toContain('.tower-input-focused .tower-mobile-tab-bar');
  });
});
