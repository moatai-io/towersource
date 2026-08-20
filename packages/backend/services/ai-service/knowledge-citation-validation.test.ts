import { describe, expect, it } from 'vitest';
import { AIServiceKnowledgeCitationError, KNOWLEDGE_CITATION_PUBLIC_MESSAGE, parseKnowledgeReadEvidence, publicAIServiceErrorMessage, validateKnowledgeAnswerCitations } from './knowledge-citation-validation.js';

const evidence = {
  documentId: 'doc_406339be7e6a6d27', path: 'final/README.md', title: 'README', sha256: 'abc',
  lineStart: 10, lineEnd: 20, citation: 'final/README.md#L10-L20',
};

describe('AI Service Knowledge citation validation', () => {
  it('keeps detailed citation diagnostics internal while exposing a safe public message', () => {
    const error = new AIServiceKnowledgeCitationError('AI Service Knowledge citation validation failed: secret/path.md#L99-L120');
    expect(error.message).toContain('secret/path.md#L99-L120');
    expect(error.code).toBe('AI_SERVICE_KNOWLEDGE_CITATION_INVALID');
    expect(publicAIServiceErrorMessage(error)).toBe(KNOWLEDGE_CITATION_PUBLIC_MESSAGE);
    expect(publicAIServiceErrorMessage(new Error('ordinary failure'))).toBe('ordinary failure');
  });

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

  it('parses multiple comma-separated ranges for the same read document', () => {
    const result = validateKnowledgeAnswerCitations('근거입니다. [K1: final/README.md#L10-L12, #L15-L16, #L19-L20]', [evidence]);
    expect(result.invalid).toEqual([]);
    expect(result.verified).toEqual([
      expect.objectContaining({ path: 'final/README.md', citedLineStart: 10, citedLineEnd: 12, label: 'K1' }),
      expect.objectContaining({ path: 'final/README.md', citedLineStart: 15, citedLineEnd: 16, label: 'K1' }),
      expect.objectContaining({ path: 'final/README.md', citedLineStart: 19, citedLineEnd: 20, label: 'K1' }),
    ]);
  });

  it('rejects only the comma-separated ranges outside the actual read result', () => {
    const result = validateKnowledgeAnswerCitations('근거입니다. final/README.md#L10-L12, #L21-L25', [evidence]);
    expect(result.verified).toEqual([expect.objectContaining({ citedLineStart: 10, citedLineEnd: 12 })]);
    expect(result.invalid).toEqual([{ path: 'final/README.md', lineStart: 21, lineEnd: 25 }]);
  });

  it('allows an answer with no citation while returning no verified evidence', () => {
    expect(validateKnowledgeAnswerCitations('자료에서 근거를 찾지 못했습니다.', [evidence])).toEqual({ verified: [], invalid: [] });
  });
});
