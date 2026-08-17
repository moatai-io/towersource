import { describe, expect, it } from 'vitest';
import { parseKnowledgeReadEvidence, validateKnowledgeAnswerCitations } from './knowledge-citation-validation.js';

const evidence = {
  documentId: 'doc_406339be7e6a6d27', path: 'final/README.md', title: 'README', sha256: 'abc',
  lineStart: 10, lineEnd: 20, citation: 'final/README.md#L10-L20',
};

describe('AI Service Knowledge citation validation', () => {
  it('parses only internally consistent knowledge_read JSON evidence', () => {
    expect(parseKnowledgeReadEvidence(JSON.stringify(evidence))).toEqual(evidence);
    expect(parseKnowledgeReadEvidence('{bad')).toBeNull();
    expect(parseKnowledgeReadEvidence(JSON.stringify({ ...evidence, citation: 'other.md#L1-L2' }))).toBeNull();
  });

  it('accepts citations fully contained in the actual read range', () => {
    const result = validateKnowledgeAnswerCitations('복사 승격합니다. [K1: `final/README.md` L10–L12]', [evidence]);
    expect(result.invalid).toEqual([]);
    expect(result.verified).toEqual([expect.objectContaining({ path: 'final/README.md', citedLineStart: 10, citedLineEnd: 12, label: 'K1' })]);
  });

  it('rejects a cited range outside the actual read result', () => {
    const result = validateKnowledgeAnswerCitations('근거입니다. [K1: final/README.md#L18-L25]', [evidence]);
    expect(result.verified).toEqual([]);
    expect(result.invalid).toEqual([{ path: 'final/README.md', lineStart: 18, lineEnd: 25 }]);
  });

  it('rejects a citation to a path that was never read', () => {
    const result = validateKnowledgeAnswerCitations('근거입니다. [K2: secret/policy.md#L1-L3]', [evidence]);
    expect(result.verified).toEqual([]);
    expect(result.invalid).toEqual([{ path: 'secret/policy.md', lineStart: 1, lineEnd: 3 }]);
  });

  it('allows an answer with no citation while returning no verified evidence', () => {
    expect(validateKnowledgeAnswerCitations('자료에서 근거를 찾지 못했습니다.', [evidence])).toEqual({ verified: [], invalid: [] });
  });
});
