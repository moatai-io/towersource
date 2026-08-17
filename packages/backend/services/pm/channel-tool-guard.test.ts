import { describe, expect, it } from 'vitest';
import { buildToolGuard } from './project-access.js';

describe('channel audience ToolGuard', () => {
  const root = '/workspace/shared-project';

  it('fails closed for file access when the channel has no audience-safe linked roots', () => {
    const guard = buildToolGuard({ role: 'admin', accessiblePaths: [], denyImplicitBash: true });
    expect(guard('Read', { file_path: '/workspace/private/file.md' }).allowed).toBe(false);
  });

  it('allows reads inside the audience-safe linked root', () => {
    const guard = buildToolGuard({ role: 'admin', accessiblePaths: [root], readOnlyPaths: [root], denyImplicitBash: true });
    expect(guard('Read', { file_path: `${root}/report.md` }).allowed).toBe(true);
  });

  it('blocks writes when the channel link is read-only even for an admin caller', () => {
    const guard = buildToolGuard({ role: 'admin', accessiblePaths: [root], readOnlyPaths: [root], denyImplicitBash: true });
    const result = guard('Write', { file_path: `${root}/report.md`, content: 'changed' });
    expect(result.allowed).toBe(false);
  });

  it('allows immutable deployment Knowledge tools without granting filesystem authority', () => {
    const guard = buildToolGuard({ role: 'member', accessiblePaths: [], channelSafeToolsOnly: true });
    expect(guard('KnowledgeSearch', { query: 'refund' }).allowed).toBe(true);
    expect(guard('KnowledgeRead', { documentId: 'doc_123' }).allowed).toBe(true);
  });

  it('blocks connectors and credential-backed tools without audience-scoped authority', () => {
    const guard = buildToolGuard({ role: 'admin', accessiblePaths: [root], channelSafeToolsOnly: true });
    const result = guard('mcp__gws__gmail_search', { query: 'secret' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toContain('not available in shared channel runs');
  });

  it('blocks Bash because cwd would otherwise become an implicit authority root', () => {
    const guard = buildToolGuard({ role: 'admin', accessiblePaths: [root], denyImplicitBash: true });
    const result = guard('Bash', { command: 'cat AGENTS.md' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toContain('Bash is disabled in shared channel runs');
  });
});
