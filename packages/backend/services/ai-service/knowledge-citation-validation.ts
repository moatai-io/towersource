/**
 * Owns: server-side validation of AI Service Knowledge citations against same-turn knowledge_read results.
 * Public API: parseKnowledgeReadEvidence, validateKnowledgeAnswerCitations.
 */

export const KNOWLEDGE_CITATION_PUBLIC_MESSAGE = '답변의 출처를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';

export class AIServiceKnowledgeCitationError extends Error {
  readonly code = 'AI_SERVICE_KNOWLEDGE_CITATION_INVALID';
  readonly publicMessage = KNOWLEDGE_CITATION_PUBLIC_MESSAGE;

  constructor(message: string) {
    super(message);
    this.name = 'AIServiceKnowledgeCitationError';
  }
}

export function publicAIServiceErrorMessage(err: unknown, fallback = 'AI Service request failed'): string {
  return err instanceof AIServiceKnowledgeCitationError ? err.publicMessage : err instanceof Error ? err.message : fallback;
}

export interface KnowledgeReadEvidence {
  documentId: string;
  path: string;
  title: string;
  sha256: string;
  lineStart: number;
  lineEnd: number;
  citation: string;
}

export interface VerifiedKnowledgeCitation extends KnowledgeReadEvidence {
  citedLineStart: number;
  citedLineEnd: number;
  label?: string;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Parse the JSON text persisted for one knowledge_read result. Invalid or unrelated tool results are ignored. */
export function parseKnowledgeReadEvidence(resultText: string): KnowledgeReadEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return null;
  }
  const value = safeRecord(parsed);
  if (!value) return null;
  const lineStart = Number(value.lineStart);
  const lineEnd = Number(value.lineEnd);
  if (typeof value.documentId !== 'string' || !value.documentId.startsWith('doc_') ||
      typeof value.path !== 'string' || !value.path || typeof value.title !== 'string' ||
      typeof value.sha256 !== 'string' || !Number.isInteger(lineStart) || !Number.isInteger(lineEnd) ||
      lineStart < 1 || lineEnd < lineStart) return null;
  const citation = `${value.path}#L${lineStart}-L${lineEnd}`;
  if (typeof value.citation !== 'string' || value.citation !== citation) return null;
  return { documentId: value.documentId, path: value.path, title: value.title, sha256: value.sha256, lineStart, lineEnd, citation };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function citationRanges(value: string): Array<{ lineStart: number; lineEnd: number }> {
  return [...value.matchAll(/(?:#?L|lines?\s*)?(\d+)[–—-](?:L)?(\d+)/giu)].map((match) => ({
    lineStart: Number(match[1]),
    lineEnd: Number(match[2]),
  }));
}

/**
 * Validate path/line citations in final text against same-turn knowledge_read evidence.
 * A cited range must be fully contained in a range that the runtime actually returned.
 */
export function validateKnowledgeAnswerCitations(text: string, evidence: KnowledgeReadEvidence[]): {
  verified: VerifiedKnowledgeCitation[];
  invalid: Array<{ path: string; lineStart: number; lineEnd: number }>;
} {
  const verified: VerifiedKnowledgeCitation[] = [];
  const invalid: Array<{ path: string; lineStart: number; lineEnd: number }> = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    const path = escaped(item.path);
    const pattern = new RegExp(`(?:\\[K(\\d+)\\s*[:：]\\s*)?[\\x60]?${path}[\\x60]?\\s*((?:#?L|lines?\\s*)?\\d+[–—-](?:L)?\\d+(?:\\s*,\\s*(?:#?L|lines?\\s*)?\\d+[–—-](?:L)?\\d+)*)`, 'giu');
    for (const match of text.matchAll(pattern)) {
      for (const { lineStart, lineEnd } of citationRanges(match[2])) {
        const key = `${item.path}:${lineStart}:${lineEnd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (lineStart >= item.lineStart && lineEnd <= item.lineEnd && lineEnd >= lineStart) {
          verified.push({ ...item, citedLineStart: lineStart, citedLineEnd: lineEnd, label: match[1] ? `K${match[1]}` : undefined });
        } else {
          invalid.push({ path: item.path, lineStart, lineEnd });
        }
      }
    }
  }

  // Detect citations to snapshot-looking paths that were never returned by knowledge_read.
  const generic = /(?:\[K\d+\s*[:：]\s*)?[`]?([\p{L}\p{N}_. /-]+?\.(?:md|txt))[`]?\s*((?:#?L|lines?\s*)?\d+[–—-](?:L)?\d+(?:\s*,\s*(?:#?L|lines?\s*)?\d+[–—-](?:L)?\d+)*)/giu;
  for (const match of text.matchAll(generic)) {
    const path = match[1].trim().split(/\s+/).at(-1) || '';
    for (const { lineStart, lineEnd } of citationRanges(match[2])) {
      const key = `${path}:${lineStart}:${lineEnd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      invalid.push({ path, lineStart, lineEnd });
    }
  }
  return { verified, invalid };
}
