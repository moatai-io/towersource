import { describe, expect, it } from 'vitest';
import { resolveInitialLanguage } from './i18n';

describe('resolveInitialLanguage', () => {
  it('defaults to English for the public OSS build', () => {
    expect(resolveInitialLanguage(null, undefined)).toBe('en');
  });

  it('uses the configured runtime default when no user preference exists', () => {
    expect(resolveInitialLanguage(null, 'ko')).toBe('ko');
  });

  it('keeps the explicit user preference above the VM default', () => {
    expect(resolveInitialLanguage('en', 'ko')).toBe('en');
  });

  it('ignores unsupported language values', () => {
    expect(resolveInitialLanguage('fr', 'de')).toBe('en');
  });
});
