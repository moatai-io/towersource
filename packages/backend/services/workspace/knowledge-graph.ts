/**
 * Owns: read-only link graph over document-like workspace files.
 * Public API: buildWorkspaceKnowledgeGraph(rootPath, options).
 * See: README.md.
 */
import fsp from 'fs/promises';
import path from 'path';
import { scanNotesIndex, type NoteItem } from './notes-index.js';

export type KnowledgeGraphEdgeKind = 'markdown-link' | 'wiki-link' | 'source' | 'lineage';

export interface KnowledgeGraphNode {
  id: string;
  path: string;
  label: string;
  kind: NoteItem['kind'] | 'unresolved';
  inferredType: NoteItem['inferredType'] | 'unresolved';
  score: number;
  modified?: string;
  size?: number;
  unresolved?: boolean;
  degree: number;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: KnowledgeGraphEdgeKind;
  weight: number;
  inferred: false;
}

export interface WorkspaceKnowledgeGraph {
  projectRoot: string;
  generatedAt: string;
  truncated: boolean;
  summary: {
    nodes: number;
    edges: number;
    connectedNodes: number;
    orphanNodes: number;
    unresolvedNodes: number;
  };
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

interface RawRelation {
  target: string;
  kind: KnowledgeGraphEdgeKind;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function stripLinkDecoration(value: string): string {
  let clean = value.trim().replace(/^<|>$/g, '');
  try { clean = decodeURIComponent(clean); } catch { /* keep malformed input literal */ }
  return clean.split('#')[0].split('?')[0].trim();
}

function extractFrontmatterRelations(text: string): RawRelation[] {
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)?.[1];
  if (!frontmatter) return [];

  const relations: RawRelation[] = [];
  let active: 'source' | 'lineage' | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const heading = line.match(/^\s*(sources|lineage)\s*:\s*(.*)$/i);
    if (heading) {
      active = heading[1].toLowerCase() === 'sources' ? 'source' : 'lineage';
      const inline = heading[2].trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const item of inline.slice(1, -1).split(',')) {
          const target = item.trim().replace(/^['"]|['"]$/g, '');
          if (target) relations.push({ target, kind: active });
        }
        active = null;
      }
      continue;
    }
    const item = active ? line.match(/^\s*-\s+(.+?)\s*$/) : null;
    if (active && item?.[1]) {
      const target = item[1].trim().replace(/^['"]|['"]$/g, '');
      if (target) relations.push({ target, kind: active });
      continue;
    }
    if (/^\S/.test(line)) active = null;
  }
  return relations;
}

/** Extracts explicit Markdown, wiki, sources, and lineage references without semantic inference. */
export function extractKnowledgeGraphRelations(text: string): RawRelation[] {
  const relations: RawRelation[] = [];
  for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    if (match[1]) relations.push({ target: match[1], kind: 'markdown-link' });
  }
  for (const match of text.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    if (match[1]) relations.push({ target: match[1], kind: 'wiki-link' });
  }
  relations.push(...extractFrontmatterRelations(text));
  return relations;
}

function candidatePaths(sourcePath: string, rawTarget: string): string[] {
  const target = stripLinkDecoration(rawTarget);
  if (!target || target.startsWith('#') || /^(?:https?:|mailto:|data:|obsidian:)/i.test(target)) return [];
  const sourceDir = path.posix.dirname(sourcePath);
  const base = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(sourceDir, target));
  if (base === '..' || base.startsWith('../')) return [];
  const candidates = [base];
  if (!path.posix.extname(base)) candidates.push(`${base}.md`, `${base}.mdx`, path.posix.join(base, 'index.md'));
  return [...new Set(candidates)];
}

function titleKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\.mdx?$/i, '');
}

function resolveTarget(
  sourcePath: string,
  target: string,
  pathSet: Set<string>,
  titleLookup: Map<string, string[]>,
): { id: string; unresolved: boolean } | null {
  for (const candidate of candidatePaths(sourcePath, target)) {
    if (pathSet.has(candidate)) return { id: candidate, unresolved: false };
  }

  const clean = stripLinkDecoration(target);
  if (!clean || /^(?:https?:|mailto:|data:|obsidian:)/i.test(clean)) return null;
  const matches = titleLookup.get(titleKey(path.posix.basename(clean))) || [];
  if (matches.length === 1) return { id: matches[0], unresolved: false };

  const candidates = candidatePaths(sourcePath, target);
  if (!candidates.length) return null;
  return { id: `unresolved:${candidates[0]}`, unresolved: true };
}

/** Builds an Obsidian-style explicit-link graph from the existing Notes Index candidate set. */
export async function buildWorkspaceKnowledgeGraph(
  rootPath: string,
  options: { maxFiles?: number; maxDepth?: number; includeUnresolved?: boolean } = {},
): Promise<WorkspaceKnowledgeGraph> {
  const maxFiles = Math.max(50, Math.min(options.maxFiles ?? 1500, 5000));
  const index = await scanNotesIndex(rootPath, { mode: 'all', maxFiles, maxDepth: options.maxDepth ?? 8 });
  const items = index.folders.flatMap((folder) => folder.items);
  const pathSet = new Set(items.map((item) => item.path));
  const titleLookup = new Map<string, string[]>();
  for (const item of items) {
    for (const key of new Set([titleKey(item.title), titleKey(path.posix.basename(item.path))])) {
      titleLookup.set(key, [...(titleLookup.get(key) || []), item.path]);
    }
  }

  const nodeMap = new Map<string, KnowledgeGraphNode>(items.map((item) => [item.path, {
    id: item.path,
    path: item.path,
    label: item.displayTitle,
    kind: item.kind,
    inferredType: item.inferredType,
    score: item.score,
    modified: item.modified,
    size: item.size,
    degree: 0,
  }]));
  const edges: KnowledgeGraphEdge[] = [];
  const edgeKeys = new Set<string>();

  for (const item of items) {
    if (item.kind !== 'markdown') continue;
    const text = await fsp.readFile(item.absolutePath, 'utf8').catch(() => '');
    for (const relation of extractKnowledgeGraphRelations(text)) {
      const resolved = resolveTarget(item.path, relation.target, pathSet, titleLookup);
      if (!resolved || resolved.id === item.path || (resolved.unresolved && options.includeUnresolved === false)) continue;
      const key = `${item.path}\u0000${resolved.id}\u0000${relation.kind}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);

      if (resolved.unresolved && !nodeMap.has(resolved.id)) {
        const unresolvedPath = resolved.id.replace(/^unresolved:/, '');
        nodeMap.set(resolved.id, {
          id: resolved.id,
          path: unresolvedPath,
          label: path.posix.basename(unresolvedPath).replace(/\.mdx?$/i, ''),
          kind: 'unresolved',
          inferredType: 'unresolved',
          score: 0,
          unresolved: true,
          degree: 0,
        });
      }
      edges.push({
        id: `${edges.length}:${item.path}:${resolved.id}`,
        source: item.path,
        target: resolved.id,
        kind: relation.kind,
        weight: relation.kind === 'source' || relation.kind === 'lineage' ? 1.5 : 1,
        inferred: false,
      });
      nodeMap.get(item.path)!.degree += 1;
      nodeMap.get(resolved.id)!.degree += 1;
    }
  }

  const nodes = [...nodeMap.values()];
  const connectedNodes = nodes.filter((node) => node.degree > 0).length;
  return {
    projectRoot: toPosix(path.resolve(rootPath)),
    generatedAt: new Date().toISOString(),
    truncated: index.summary.totalItems >= maxFiles,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      connectedNodes,
      orphanNodes: nodes.length - connectedNodes,
      unresolvedNodes: nodes.filter((node) => node.unresolved).length,
    },
    nodes,
    edges,
  };
}
