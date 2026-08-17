import { describe, expect, it } from 'vitest';
import { buildLanguagePolicyBlock, resolveLanguage } from './language-resolver.js';

describe('language-resolver', () => {
  it('resolves session language before user and environment defaults', () => {
    expect(resolveLanguage({ language: 'en' }, { language: 'ko' })).toBe('ko');
  });

  it('includes a Markdown bold spacing guard in the language policy', () => {
    const policy = buildLanguagePolicyBlock('ko');

    expect(policy).toContain('use `**text**`, not `** text **`');
    expect(policy).toContain('use `**텍스트**`, not `** 텍스트 **`');
  });
});
