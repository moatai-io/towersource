import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildWorkspaceKnowledgeGraph, extractKnowledgeGraphRelations } from './knowledge-graph.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tower-knowledge-graph-'));
  tempRoots.push(root);
  return root;
}

describe('extractKnowledgeGraphRelations', () => {
  it('extracts markdown, wiki, sources, and lineage links', () => {
    const result = extractKnowledgeGraphRelations(`---\nsources:\n  - ../sources/base.md\nlineage: [../records/old.md]\n---\n[Guide](./guide.md) [[Decision|결정]] ![[image.png]]`);
    expect(result).toEqual(expect.arrayContaining([
      { target: './guide.md', kind: 'markdown-link' },
      { target: 'Decision', kind: 'wiki-link' },
      { target: 'image.png', kind: 'wiki-link' },
      { target: '../sources/base.md', kind: 'source' },
      { target: '../records/old.md', kind: 'lineage' },
    ]));
  });
});

describe('buildWorkspaceKnowledgeGraph', () => {
  it('resolves relative and title-based links and keeps unresolved references', async () => {
    const root = await makeRoot();
    await fsp.mkdir(path.join(root, 'docs'), { recursive: true });
    await fsp.writeFile(path.join(root, 'docs', 'home.md'), '# Home\n[[Guide]]\n[[Missing Note]]');
    await fsp.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n[Home](./home.md)');

    const graph = await buildWorkspaceKnowledgeGraph(root, { includeUnresolved: true });
    expect(graph.nodes.some((node) => node.path === 'docs/home.md')).toBe(true);
    expect(graph.nodes.some((node) => node.path === 'docs/guide.md')).toBe(true);
    expect(graph.nodes.some((node) => node.unresolved && node.label === 'Missing Note')).toBe(true);
    expect(graph.edges.some((edge) => edge.source === 'docs/home.md' && edge.target === 'docs/guide.md')).toBe(true);
    expect(graph.summary.unresolvedNodes).toBe(1);
  });

  it('does not resolve paths that escape the project root', async () => {
    const root = await makeRoot();
    await fsp.mkdir(path.join(root, 'docs'), { recursive: true });
    await fsp.writeFile(path.join(root, 'docs', 'home.md'), '# Home\n[Outside](../../outside.md)');

    const graph = await buildWorkspaceKnowledgeGraph(root);
    expect(graph.edges).toHaveLength(0);
    expect(graph.summary.unresolvedNodes).toBe(0);
  });
});
