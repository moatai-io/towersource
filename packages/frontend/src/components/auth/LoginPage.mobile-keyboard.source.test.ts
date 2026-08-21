import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const login = fs.readFileSync(path.resolve(__dirname, 'LoginPage.tsx'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');

describe('LoginPage mobile keyboard layout', () => {
  it('uses the visual viewport height instead of forcing a full dynamic viewport minimum', () => {
    expect(css).toContain('min-height: var(--vvh, 100dvh)');
    expect(css).not.toMatch(/\.tower-login-shell\s*\{[\s\S]*?min-height:\s*100dvh;/);
  });

  it('compacts the mobile login experience while an input is focused', () => {
    expect(css).toContain('.tower-input-focused .tower-login-hero');
    expect(css).toContain('.tower-input-focused .tower-login-logo');
    expect(css).toContain('.tower-input-focused .tower-login-layout');
  });

  it('keeps the focused field visible above the software keyboard', () => {
    expect(login).toContain('scrollIntoView({ block:');
    expect(login).toContain("setFocused(field)");
  });
});
