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
    expect(policy).toContain('Do not infer the response language from historical context');
  });

  it('includes a Markdown bold spacing guard in the language policy', () => {
    const policy = buildLanguagePolicyBlock('ko');

    expect(policy).toContain('use `**text**`, not `** text **`');
    expect(policy).toContain('use `**텍스트**`, not `** 텍스트 **`');
  });

  it('adds compact clarity guidance to the Korean policy', () => {
    const policy = buildLanguagePolicyBlock('ko');

    expect(policy).toContain('주체와 행동이 드러나도록 필요한 조사와 서술어');
    expect(policy).toContain('제목·짧은 목록·표·UI 문구');
    expect(policy).toContain('본문은 자연스러운 완결 문장으로');
    expect(policy).toContain('번역투·명사 나열·모호한 내부 은어');
  });

  it.each(['ko', 'en', 'ja', 'zh', 'es', 'fr', 'de'])('uses a language-neutral request rule for %s', (language) => {
    const policy = buildLanguagePolicyBlock(language);
    expect(policy).toContain('Use only the language explicitly requested by the user, or the configured language if none is requested');
    expect(policy).toContain('do not switch or mix languages without a request');
    expect(policy).toContain('Necessary quotations, translations, code, and proper nouns are exceptions');
    expect(policy).not.toContain('모든 설명은 한국어로');
    expect(policy).not.toContain('unless the user writes in a different language');
  });

  it('does not add Korean clarity guidance to the English policy', () => {
    const policy = buildLanguagePolicyBlock('en');

    expect(policy).not.toContain('주체와 행동이 드러나도록 필요한 조사와 서술어');
    expect(policy).not.toContain('번역투·명사 나열·모호한 내부 은어');
  });
});
