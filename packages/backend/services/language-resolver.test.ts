import { describe, expect, it } from 'vitest';
import { buildLanguagePolicyBlock, resolveLanguage } from './language-resolver.js';

describe('language-resolver', () => {
  it('resolves session language before user and organization defaults', () => {
    expect(resolveLanguage({ language: 'en' }, { language: 'ko' }, { language: 'en' })).toBe('ko');
  });

  it('uses the Admin default before the VM fallback', () => {
    const previous = process.env.WORKSPACE_LANGUAGE;
    process.env.WORKSPACE_LANGUAGE = 'ko';
    expect(resolveLanguage(null, null, { language: 'en' })).toBe('en');
    process.env.WORKSPACE_LANGUAGE = previous;
  });

  it('tells the model not to infer output language from historical context', () => {
    const policy = buildLanguagePolicyBlock('en');
    expect(policy).toContain('regardless of the language used in conversation history');
    expect(policy).toContain('do not infer the response language from historical context');
  });

  it('includes a Markdown bold spacing guard in the language policy', () => {
    const policy = buildLanguagePolicyBlock('ko');

    expect(policy).toContain('use `**text**`, not `** text **`');
    expect(policy).toContain('use `**텍스트**`, not `** 텍스트 **`');
  });
});
