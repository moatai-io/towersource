/**
 * Owns: server-side validation and immutable capture of AI Service Knowledge sources.
 * Public API: canonicalizeServiceSourceSnapshot, buildServiceKnowledgePrompt.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface EmptyServiceSourceSnapshot {
  kind: 'none';
  version: 1;
  refs: [];
  userFacingLabel: string;
}

export interface ServiceKnowledgeDocument {
  path: string;
  title: string;
  mediaType: 'text/markdown' | 'text/plain';
  bytes: number;
  sha256: string;
  content: string;
}

export interface ServiceKnowledgeSnapshot {
  kind: 'knowledge';
  version: 1;
  refs: ServiceKnowledgeDocument[];
  snapshotHash: string;
  totalBytes: number;
  userFacingLabel: string;
}

export type ServiceSourceSnapshot = EmptyServiceSourceSnapshot | ServiceKnowledgeSnapshot;

const EMPTY_SOURCE_LABEL = '연결된 배포 자료 없음';
const MAX_DOCUMENTS = 100;
const MAX_DOCUMENT_BYTES = 1_000_000;
// Snapshot storage and model context are separate budgets. The immutable snapshot may
// hold a multi-megabyte corpus because runtime access is bounded by knowledge_search/read.
const MAX_TOTAL_BYTES = 5_000_000;
const ALLOWED_EXTENSIONS: ReadonlyMap<string, ServiceKnowledgeDocument['mediaType']> = new Map([['.md', 'text/markdown'], ['.txt', 'text/plain']]);

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requestedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Knowledge source refs must be an array');
  if (value.length > MAX_DOCUMENTS) throw new Error(`Knowledge deployment accepts at most ${MAX_DOCUMENTS} documents`);
  return value.map((item) => {
    const raw = typeof item === 'string' ? item : item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>).path : undefined;
    const normalized = typeof raw === 'string' ? raw.trim().replaceAll('\\', '/') : '';
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.startsWith('~') || normalized.split('/').includes('..') || normalized.includes('\0')) {
      throw new Error('Knowledge source path must be a safe Project-relative path');
    }
    return normalized.replace(/^\.\//, '');
  });
}

function snapshotHash(refs: ServiceKnowledgeDocument[]): string {
  return createHash('sha256').update(JSON.stringify(refs.map(({ path: refPath, sha256 }) => ({ path: refPath, sha256 })))).digest('hex');
}

/** Resolve, boundary-check, read, and content-hash selected Project text documents. */
export async function canonicalizeServiceSourceSnapshot(value: unknown, projectRoot?: string): Promise<ServiceSourceSnapshot> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const kind = source.kind === undefined ? 'none' : source.kind;
  const refs = source.refs === undefined ? [] : source.refs;
  if (kind === 'none') {
    if (!Array.isArray(refs) || refs.length !== 0) throw new Error('No-Knowledge deployment cannot include source refs');
    return { kind: 'none', version: 1, refs: [], userFacingLabel: EMPTY_SOURCE_LABEL };
  }
  if (kind !== 'knowledge') throw new Error('Unsupported Knowledge source kind');
  if (!projectRoot) throw new Error('Project root required for Knowledge deployment');

  const paths = [...new Set(requestedPaths(refs))];
  if (paths.length === 0) throw new Error('Select at least one Knowledge document');
  const realRoot = await fs.realpath(projectRoot);
  const documents: ServiceKnowledgeDocument[] = [];
  let totalBytes = 0;

  for (const relativePath of paths) {
    const extension = path.extname(relativePath).toLowerCase();
    const mediaType = ALLOWED_EXTENSIONS.get(extension);
    if (!mediaType) throw new Error('Knowledge deployment currently supports Markdown and TXT documents only');
    const requested = path.resolve(realRoot, relativePath);
    if (!isInside(realRoot, requested)) throw new Error('Knowledge source escapes the Project boundary');
    const realFile = await fs.realpath(requested).catch(() => { throw new Error(`Knowledge source not found: ${relativePath}`); });
    if (!isInside(realRoot, realFile)) throw new Error('Knowledge source symlink escapes the Project boundary');
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) throw new Error(`Knowledge source must be a file: ${relativePath}`);
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error(`Knowledge source exceeds ${MAX_DOCUMENT_BYTES} bytes: ${relativePath}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Knowledge deployment exceeds ${MAX_TOTAL_BYTES} total bytes`);
    const content = await fs.readFile(realFile, 'utf8');
    documents.push({
      path: relativePath,
      title: path.basename(relativePath, extension),
      mediaType,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    });
  }

  documents.sort((a, b) => a.path.localeCompare(b.path));
  return {
    kind: 'knowledge', version: 1, refs: documents, snapshotHash: snapshotHash(documents), totalBytes,
    userFacingLabel: `배포 자료 ${documents.length}개`,
  };
}

/** Project filesystem authority 없이 immutable snapshot의 검색 가능한 문서 목록만 runtime prompt로 투영한다. */
export function buildServiceKnowledgePrompt(value: unknown): { prompt: string; citations: Array<{ path: string; title: string; sha256: string }> } {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (source.kind !== 'knowledge' || !Array.isArray(source.refs)) return { prompt: '', citations: [] };
  const refs = source.refs.filter((item): item is ServiceKnowledgeDocument => !!item && typeof item === 'object' && typeof (item as ServiceKnowledgeDocument).content === 'string');
  const citations = refs.map(({ path: refPath, title, sha256 }) => ({ path: refPath, title, sha256 }));
  const manifest = refs.map((doc, index) => `- [K${index + 1}] ${doc.title} · ${doc.path} · ${doc.bytes} bytes · SHA-256 ${doc.sha256}`);
  return {
    prompt: [
      '## Approved Deployment Knowledge',
      'The immutable Deployment snapshot contains the documents listed below. Do not assume their contents from titles. Use knowledge_search to find relevant passages and knowledge_read to inspect exact evidence before making Project-specific claims. Cite only evidence returned by knowledge_read. If the snapshot does not support an answer, say so. Never claim access to the source Project or filesystem.',
      ...manifest,
    ].join('\n\n'),
    citations,
  };
}
