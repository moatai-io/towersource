import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServiceKnowledgePrompt, canonicalizeServiceSourceSnapshot } from './source-snapshot.js';

const roots: string[] = [];
async function root() { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-ai-service-knowledge-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true }))); });

describe('AI Service source snapshot boundary', () => {
  it('canonicalizes the explicit no-Knowledge deployment source', async () => {
    await expect(canonicalizeServiceSourceSnapshot({ kind: 'none', refs: [], userFacingLabel: 'client value' })).resolves.toEqual({
      kind: 'none', version: 1, refs: [], userFacingLabel: '연결된 배포 자료 없음',
    });
  });

  it('captures approved Markdown content and hashes it immutably', async () => {
    const projectRoot = await root();
    await fs.mkdir(path.join(projectRoot, 'knowledge'));
    await fs.writeFile(path.join(projectRoot, 'knowledge', 'guide.md'), '# 환불\n7일 안에 요청합니다.');
    const snapshot = await canonicalizeServiceSourceSnapshot({ kind: 'knowledge', refs: [{ path: 'knowledge/guide.md' }] }, projectRoot);
    expect(snapshot).toMatchObject({ kind: 'knowledge', version: 1, totalBytes: expect.any(Number), userFacingLabel: '배포 자료 1개' });
    if (snapshot.kind !== 'knowledge') throw new Error('expected knowledge');
    expect(snapshot.refs[0]).toMatchObject({ path: 'knowledge/guide.md', title: 'guide', mediaType: 'text/markdown', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), content: expect.stringContaining('7일') });
    const runtime = buildServiceKnowledgePrompt(snapshot);
    expect(runtime.prompt).toContain('[K1] guide');
    expect(runtime.prompt).toContain('knowledge_search');
    expect(runtime.prompt).not.toContain('7일 안에 요청합니다.');
    expect(runtime.citations[0]).toMatchObject({ path: 'knowledge/guide.md', title: 'guide' });
  });

  it('accepts a searchable corpus larger than the old 120KB prompt-injection ceiling', async () => {
    const projectRoot = await root();
    await fs.writeFile(path.join(projectRoot, 'large.md'), `# 큰 자료\n${'검색 가능한 내용 '.repeat(12_000)}`);
    const snapshot = await canonicalizeServiceSourceSnapshot({ kind: 'knowledge', refs: ['large.md'] }, projectRoot);
    expect(snapshot).toMatchObject({ kind: 'knowledge', totalBytes: expect.any(Number) });
    if (snapshot.kind !== 'knowledge') throw new Error('expected knowledge');
    expect(snapshot.totalBytes).toBeGreaterThan(120_000);
    expect(buildServiceKnowledgePrompt(snapshot).prompt.length).toBeLessThan(2_000);
  });

  it('rejects traversal, unsupported files, and symlinks escaping the Project', async () => {
    const projectRoot = await root();
    const outside = await root();
    await fs.writeFile(path.join(projectRoot, 'data.json'), '{}');
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
    await fs.symlink(path.join(outside, 'secret.md'), path.join(projectRoot, 'linked.md'));
    await expect(canonicalizeServiceSourceSnapshot({ kind: 'knowledge', refs: ['../secret.md'] }, projectRoot)).rejects.toThrow('safe Project-relative');
    await expect(canonicalizeServiceSourceSnapshot({ kind: 'knowledge', refs: ['data.json'] }, projectRoot)).rejects.toThrow('Markdown and TXT');
    await expect(canonicalizeServiceSourceSnapshot({ kind: 'knowledge', refs: ['linked.md'] }, projectRoot)).rejects.toThrow('symlink escapes');
  });
});
