import { describe, expect, it } from 'vitest';
import { projectMarkdownArtifact } from './markdown-artifact-projection';
describe('Markdown view projection', () => {
  it('projects tool input as prose without modifying persisted/model blocks', () => {
    const source: any = { type: 'tool_use', toolUse: { id: 'one', name: 'create_markdown_artifact', input: { body: '# Body', path: 'work/a.md' }, result: JSON.stringify({ ok: true, artifact: 'markdown', path: '/project/work/a.md' }) } };
    expect(projectMarkdownArtifact(source)).toMatchObject({ type: 'artifact_markdown', text: '# Body', status: 'saved' });
    expect(source.type).toBe('tool_use'); expect(source.text).toBeUndefined();
  });
  it('distinguishes pending and failed saves', () => {
    const source: any = { type: 'tool_use', toolUse: { name: 'create_markdown_artifact', input: { body: 'Body' } } };
    expect(projectMarkdownArtifact(source).status).toBe('pending');
    source.toolUse.result = JSON.stringify({ ok: false, error: 'Denied' });
    expect(projectMarkdownArtifact(source)).toMatchObject({ status: 'error', error: undefined });
  });
});

it('projects only user-facing failure messages, never internal codes or stacks', () => {
  const source: any = { type: 'tool_use', toolUse: { name: 'create_markdown_artifact', input: { body: 'Body', path: 'new/doc.md' }, result: JSON.stringify({ ok: false, code: 'ENOENT', error: 'node:fs long stack', userMessage: '문서를 파일로 저장하지 못했습니다.' }) } };
  expect(projectMarkdownArtifact(source)).toMatchObject({ status: 'error', error: '문서를 파일로 저장하지 못했습니다.', portablePath: undefined });
});

for (const name of ['create_markdown_artifact', 'update_markdown_artifact']) {
  it(`keeps ${name} Viewer delivery out of chat prose`, () => {
    const block = projectMarkdownArtifact({ type: 'tool_use', toolUse: {
      id: 'viewer-doc', name, input: { body: '# Full document', title: 'Document', path: 'doc.md' },
      result: JSON.stringify({ ok: true, artifact: 'markdown', presentation: 'viewer', action: 'present_file', path: '/workspace/doc.md' }),
    } } as any);
    expect(block).toMatchObject({ status: 'saved', portablePath: '/workspace/doc.md' });
    expect(block.text).toBeUndefined();
  });
}
