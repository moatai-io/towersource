import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const login = fs.readFileSync(path.resolve(__dirname, 'LoginPage.tsx'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');

describe('LoginPage mobile keyboard layout', () => {
  it('owns its visual viewport height instead of depending on a global keyboard variable', () => {
    expect(login).toContain("import { useMobileKeyboardViewport } from '../../hooks/useMobileKeyboardViewport'");
    expect(login).toContain('const mobileKeyboardViewport = useMobileKeyboardViewport(true)');
    expect(login).toContain('minHeight: mobileKeyboardViewport.height');
    expect(login).not.toContain("style={{ minHeight: '100dvh' }}");
  });

  it('compacts the mobile login experience while an input is focused', () => {
    expect(css).toContain('.tower-input-focused .tower-login-hero');
    expect(css).toContain('.tower-input-focused .tower-login-logo');
    expect(css).toContain('.tower-input-focused .tower-login-layout');
  });

  it('uses a compact mobile brand and removes duplicate introductory content', () => {
    expect(login).toContain('className="tower-login-mobile-brand"');
    expect(css).toContain('.tower-login-mobile-brand {\n  display: none;');
    const mobile = css.slice(css.indexOf('@media (max-width: 560px)', css.indexOf('.tower-login-shell {')));
    expect(mobile).toContain('.tower-login-hero .tower-login-mark-card,');
    expect(mobile).toContain('.tower-login-hero .tower-login-title,');
    expect(mobile).toContain('.tower-login-hero .tower-login-subtitle,');
    expect(mobile).toContain('.tower-login-hero .tower-login-chips,');
    expect(mobile).toContain('.tower-login-card-wrap .tower-login-logo {\n    display: none;');
    expect(mobile).toContain('align-content: center;');
    expect(mobile).toContain('min-height: 100%;');
  });

  it('keeps the focused field visible above the software keyboard', () => {
    expect(login).toContain('scrollIntoView({ block:');
    expect(login).toContain("setFocused(field)");
  });
});
