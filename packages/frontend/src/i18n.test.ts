import { describe, expect, it } from 'vitest';
import { resolveInitialLanguage } from './i18n';

describe('resolveInitialLanguage', () => {
  it('defaults to Korean without a runtime setting', () => {
    expect(resolveInitialLanguage(null, undefined)).toBe('ko');
  });

  it('uses the configured runtime default when no user preference exists', () => {
    expect(resolveInitialLanguage(null, 'ko')).toBe('ko');
    expect(resolveInitialLanguage(null, 'en')).toBe('en');
  });

  it('keeps the explicit user preference above the VM default', () => {
    expect(resolveInitialLanguage('en', 'ko')).toBe('en');
  });

  it('ignores unsupported language values', () => {
    expect(resolveInitialLanguage('fr', 'de')).toBe('ko');
  });
});
