/**
 * Owns: snapshot-only Knowledge search/read for deployed AI Services.
 * Public API: normalizeSnapshotKnowledge, searchSnapshotKnowledge, readSnapshotKnowledge.
 */
import { createHash } from 'node:crypto';
import type { ServiceKnowledgeDocument } from './source-snapshot.js';

export interface SnapshotKnowledgeDocument extends ServiceKnowledgeDocument {
  documentId: string;
  lineCount: number;
}

const MAX_SEARCH_RESULTS = 10;
const MAX_READ_LINES = 80;
const MAX_READ_CHARS = 12_000;

function documentId(doc: Pick<ServiceKnowledgeDocument, 'path' | 'sha256'>): string {
  return `doc_${createHash('sha256').update(`${doc.path}\0${doc.sha256}`).digest('hex').slice(0, 16)}`;
}

function validDocument(value: unknown): value is ServiceKnowledgeDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as ServiceKnowledgeDocument;
  return typeof doc.path === 'string' && typeof doc.title === 'string' && typeof doc.sha256 === 'string' && typeof doc.content === 'string';
}

/** Normalize only embedded immutable snapshot documents. No filesystem read occurs. */
export function normalizeSnapshotKnowledge(value: unknown): SnapshotKnowledgeDocument[] {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (source.kind !== 'knowledge' || !Array.isArray(source.refs)) return [];
  return source.refs.filter(validDocument).map((doc) => ({
    ...doc,
    documentId: typeof (doc as SnapshotKnowledgeDocument).documentId === 'string' && (doc as SnapshotKnowledgeDocument).documentId
      ? (doc as SnapshotKnowledgeDocument).documentId
      : documentId(doc),
    lineCount: doc.content.split('\n').length,
  }));
}

function terms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((term) => term.trim()).filter((term) => term.length >= 2))];
}

/** Linear lexical search over one Deployment snapshot. */
export function searchSnapshotKnowledge(value: unknown, input: { query: string; scope?: string; limit?: number }) {
  const query = input.query?.trim();
  if (!query) throw new Error('knowledge_search query required');
  const queryTerms = terms(query);
  if (queryTerms.length === 0) throw new Error('knowledge_search query must include searchable text');
  const scope = input.scope?.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(input.limit || 5)));
  const results: Array<{ documentId: string; path: string; title: string; heading?: string; snippet: string; lineStart: number; lineEnd: number; citation: string; score: number }> = [];

  for (const doc of normalizeSnapshotKnowledge(value)) {
    if (scope && !(doc.path === scope || doc.path.startsWith(`${scope.replace(/\/$/, '')}/`))) continue;
    const lines = doc.content.split('\n');
    let heading = '';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const headingMatch = /^#{1,6}\s+(.+)$/.exec(line.trim());
      if (headingMatch) heading = headingMatch[1].trim();
      const haystack = `${doc.title} ${doc.path} ${heading} ${line}`.toLocaleLowerCase();
      const matched = queryTerms.filter((term) => haystack.includes(term));
      if (matched.length === 0) continue;
      const lineStart = Math.max(1, index);
      const lineEnd = Math.min(lines.length, index + 2);
      const snippet = lines.slice(lineStart - 1, lineEnd).join('\n').trim().slice(0, 900);
      results.push({
        documentId: doc.documentId, path: doc.path, title: doc.title, heading: heading || undefined,
        snippet, lineStart, lineEnd, citation: `${doc.path}#L${lineStart}-L${lineEnd}`,
        score: matched.length * 10 + (doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? 5 : 0),
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineStart - b.lineStart).slice(0, limit);
}

/** Read a bounded line range by opaque snapshot document ID. */
export function readSnapshotKnowledge(value: unknown, input: { documentId: string; lineStart?: number; lineEnd?: number }) {
  const doc = normalizeSnapshotKnowledge(value).find((candidate) => candidate.documentId === input.documentId);
  if (!doc) throw new Error('Knowledge document not found in this Deployment snapshot');
  const lines = doc.content.split('\n');
  const lineStart = Math.max(1, Math.floor(input.lineStart || 1));
  const requestedEnd = Math.floor(input.lineEnd || Math.min(lines.length, lineStart + 39));
  const lineEnd = Math.min(lines.length, Math.max(lineStart, Math.min(requestedEnd, lineStart + MAX_READ_LINES - 1)));
  const content = lines.slice(lineStart - 1, lineEnd).join('\n').slice(0, MAX_READ_CHARS);
  return {
    documentId: doc.documentId, path: doc.path, title: doc.title, sha256: doc.sha256,
    lineStart, lineEnd, content, citation: `${doc.path}#L${lineStart}-L${lineEnd}`,
  };
}
