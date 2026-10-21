import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './project-files-router.ts'), 'utf8');

describe('Project derived index storage authority', () => {
  it('resolves Project workspace authority before host Notes or graph scanning', () => {
    expect(source).toContain('async function assertHostAuthoritativeProjectDirectory');
    expect(source).toContain('resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath, allowProjectRoot: true })');
    expect(source).toContain('PROJECT_WORKSPACE_INDEX_REQUIRES_AUTHORITATIVE_SNAPSHOT');

    const notes = source.slice(source.indexOf("router.get('/files/notes-index'"), source.indexOf("router.get('/files/knowledge-graph'"));
    expect(notes.indexOf('assertHostAuthoritativeProjectDirectory')).toBeLessThan(notes.indexOf('scanNotesIndex'));

    const graph = source.slice(source.indexOf("router.get('/files/knowledge-graph'"), source.indexOf("router.get('/files/reveal'"));
    expect(graph.indexOf('assertHostAuthoritativeProjectDirectory')).toBeLessThan(graph.indexOf('buildWorkspaceKnowledgeGraph'));
  });

  it('surfaces storage authority refusal as service unavailable', () => {
    expect(source).toContain('res.status(error?.statusCode || 500)');
    expect(source).toContain('(error as any).statusCode = 503');
  });
});
