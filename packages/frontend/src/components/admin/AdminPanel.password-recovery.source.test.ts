import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));

describe('Admin password recovery visibility', () => {
  it('allows password reveal only for admins while keeping reset available', () => {
    expect(source).toContain("canReveal={role === 'admin'}");
    expect(source).toContain('{canReveal && <button');
    expect(source).toContain("onClick={() => { setDraft(password); setEditing(true); }}");
  });

  it('requires confirmation and remasks after 20 seconds', () => {
    expect(source).toContain("title: t('revealPasswordTitle')");
    expect(source).toContain("message: t('revealPasswordConfirm', { username })");
    expect(source).toContain('window.setTimeout(() => setVisible(false), 20_000)');
  });

  it('ships Korean and English recovery copy', () => {
    for (const key of ['revealPasswordTitle', 'revealPasswordConfirm', 'revealForRecovery']) {
      expect(ko[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });
});
