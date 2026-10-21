import { describe, expect, it } from 'vitest';
import { languageRequestEvidence } from './language-request-evidence.js';
import { buildLanguagePolicyBlock } from '../../services/language-resolver.js';

describe('language request evidence', () => {
  it('records language and commentary policy without leaking instructions or conversation', () => {
    const instructions = buildLanguagePolicyBlock('ko') + '\nPRIVATE_SENTINEL';
    const evidence = languageRequestEvidence(JSON.stringify({ instructions, input: 'PRIVATE_INPUT' }));
    expect(evidence).toMatchObject({ instructionsState: 'present', languagePolicyPresent: true,
      configuredLanguages: ['ko'], languagePolicyCount: 1, commentaryPolicyPresent: true });
    expect(evidence.instructionsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|Respond in/);
    expect(languageRequestEvidence(JSON.stringify({ instructions }))).toEqual(evidence);
    expect(languageRequestEvidence(JSON.stringify({ instructions: instructions + 'x' }))).not.toEqual(evidence);
  });
  it('ignores policy text from input and distinguishes missing/malformed bodies', () => {
    expect(languageRequestEvidence(JSON.stringify({ input: buildLanguagePolicyBlock('ja') }))).toEqual({ instructionsState: 'absent' });
    expect(languageRequestEvidence(undefined)).toEqual({ instructionsState: 'unavailable' });
    expect(languageRequestEvidence('{')).toEqual({ instructionsState: 'invalid-json' });
    expect(languageRequestEvidence('null')).toEqual({ instructionsState: 'absent' });
  });
  it('exposes conflicting policies rather than silently choosing one', () => {
    const evidence = languageRequestEvidence(JSON.stringify({ instructions: buildLanguagePolicyBlock('ko') + buildLanguagePolicyBlock('en') }));
    expect(evidence.configuredLanguages).toEqual(['ko', 'en']);
    expect(evidence.languagePolicyCount).toBe(2);
  });
});
