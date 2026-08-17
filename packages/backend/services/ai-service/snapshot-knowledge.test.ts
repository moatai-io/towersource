import { describe, expect, it } from 'vitest';
import { normalizeSnapshotKnowledge, readSnapshotKnowledge, searchSnapshotKnowledge } from './snapshot-knowledge.js';

const snapshot = {
  kind: 'knowledge', version: 1, refs: [
    { path: 'knowledge/policies/refund.md', title: 'refund', mediaType: 'text/markdown', bytes: 55, sha256: 'abc123', content: '# 환불 정책\n\n결제일로부터 7일 이내 환불할 수 있습니다.\n전자책은 다운로드 전이어야 합니다.' },
    { path: 'knowledge/guide.txt', title: 'guide', mediaType: 'text/plain', bytes: 30, sha256: 'def456', content: '문의는 support@example.com으로 보내세요.' },
  ],
};

describe('AI Service snapshot Knowledge', () => {
  it('creates stable opaque document IDs without reading a filesystem', () => {
    const first = normalizeSnapshotKnowledge(snapshot);
    const second = normalizeSnapshotKnowledge(structuredClone(snapshot));
    expect(first[0].documentId).toMatch(/^doc_[a-f0-9]{16}$/);
    expect(second[0].documentId).toBe(first[0].documentId);
    expect(first[0].lineCount).toBe(4);
  });

  it('searches title, path, heading, and body inside only the supplied snapshot', () => {
    const results = searchSnapshotKnowledge(snapshot, { query: '환불 7일', scope: 'knowledge/policies', limit: 3 });
    expect(results[0]).toMatchObject({ path: 'knowledge/policies/refund.md', title: 'refund', heading: '환불 정책', lineStart: 2, lineEnd: 4 });
    expect(results[0].citation).toContain('#L2-L4');
    expect(searchSnapshotKnowledge(snapshot, { query: 'support', scope: 'knowledge/policies' })).toEqual([]);
  });

  it('reads bounded lines only by an ID from this Deployment snapshot', () => {
    const documentId = normalizeSnapshotKnowledge(snapshot)[0].documentId;
    expect(readSnapshotKnowledge(snapshot, { documentId, lineStart: 3, lineEnd: 999 })).toMatchObject({
      path: 'knowledge/policies/refund.md', lineStart: 3, lineEnd: 4,
      content: '결제일로부터 7일 이내 환불할 수 있습니다.\n전자책은 다운로드 전이어야 합니다.',
    });
    expect(() => readSnapshotKnowledge(snapshot, { documentId: 'doc_other_deployment' })).toThrow('not found in this Deployment snapshot');
  });

  it('rejects empty search and treats non-Knowledge input as no documents', () => {
    expect(() => searchSnapshotKnowledge(snapshot, { query: ' ' })).toThrow('query required');
    expect(normalizeSnapshotKnowledge({ kind: 'none', refs: [] })).toEqual([]);
  });
});
