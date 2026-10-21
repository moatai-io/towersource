import { describe, expect, it } from 'vitest';
import { normalizeContentBlocks } from './message-parser';

describe('normalizeContentBlocks', () => {
  it('normalizes hidden commentary blocks as hidden non-prose blocks', () => {
    const normalized = normalizeContentBlocks([
      { type: 'commentary', text: 'Need internal planning.' },
      { type: 'text', text: 'final answer' },
    ]);

    expect(normalized).toEqual([
      { type: 'commentary', text: '', phase: 'commentary', visibility: 'hidden' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('preserves progress commentary as user-visible assistant prose', () => {
    const normalized = normalizeContentBlocks([
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
      { type: 'text', text: 'final answer' },
    ]);

    expect(normalized).toEqual([
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('parses SDK commentary blocks without turning hidden commentary into text', async () => {
    const { parseSDKMessage } = await import('./message-parser');

    expect(parseSDKMessage({ message: { content: [
      { type: 'commentary', text: 'Need internal planning.' },
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', visibility: 'progress' },
      { type: 'text', text: 'final answer' },
    ] } })).toEqual([
      { type: 'commentary', text: '', phase: 'commentary', visibility: 'hidden' },
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('converts raw tower-artifact fences into markdown artifact blocks on the frontend fallback path', () => {
    const normalized = normalizeContentBlocks([
      { type: 'text', text: 'Before\n```tower-artifact path="work/report.md" title="Report"\n# Report\n\nBody\n```\nAfter' },
    ]);

    expect(normalized).toMatchObject([
      { type: 'text', text: 'Before' },
      { type: 'artifact_markdown', path: 'work/report.md', title: 'Report', text: '# Report\n\nBody', status: 'pending' },
      { type: 'text', text: 'After' },
    ]);
  });

  it('unwraps tower-artifact fences even when they were accidentally nested in an md code fence', () => {
    const normalized = normalizeContentBlocks([
      { type: 'text', text: '```md\n```tower-artifact path="work/report.md"\n# Report\n```\n```' },
    ]);

    expect(normalized).toMatchObject([
      { type: 'artifact_markdown', path: 'work/report.md', text: '# Report', status: 'pending' },
    ]);
  });

  it('preserves artifact-backed markdown blocks for chat rendering and file opening', () => {
    const normalized = normalizeContentBlocks([
      {
        type: 'artifact_markdown',
        path: 'work/report.md',
        portablePath: '~/workspace/projects/demo/work/report.md',
        title: 'Report',
        text: '# Report\n\nBody',
        sha256: 'abc123',
        status: 'saved',
      },
    ]);

    expect(normalized).toEqual([
      {
        type: 'artifact_markdown',
        path: 'work/report.md',
        portablePath: '~/workspace/projects/demo/work/report.md',
        title: 'Report',
        text: '# Report\n\nBody',
        sha256: 'abc123',
        status: 'saved',
        error: undefined,
      },
    ]);
  });

  it('preserves structured agent_run artifact and identity metadata', () => {
    const normalized = normalizeContentBlocks([
      {
        type: 'agent_run',
        workerName: 'Research worker',
        workerRole: 'Independent reviewer',
        workerFace: '🧭',
        workerTagline: 'Checks evidence',
        summary: '조사 완료',
        detailArtifacts: '- old text pointer',
        detailArtifactPaths: ['~/workspace/projects/tower/research/deep.md'],
        detailArtifactSummary: '긴 원문과 비교표',
        readIfNeeded: '§4',
        retrievalHint: 'Use persistent_agent_status.',
      },
    ]);

    expect(normalized[0].agentRun).toMatchObject({
      workerName: 'Research worker',
      workerRole: 'Independent reviewer',
      workerFace: '🧭',
      workerTagline: 'Checks evidence',
      detailArtifactPaths: ['~/workspace/projects/tower/research/deep.md'],
      detailArtifactSummary: '긴 원문과 비교표',
      readIfNeeded: '§4',
      retrievalHint: 'Use persistent_agent_status.',
    });
  });

  it('preserves prior tool results across streaming assistant updates', () => {
    const previous = [
      {
        type: 'tool_use' as const,
        toolUse: {
          id: 'tool-1',
          name: 'Read',
          input: { path: '/tmp/a.txt' },
          result: 'hello world',
        },
      },
    ];

    const next = [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a.txt' } },
      { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'pwd' } },
    ];

    const normalized = normalizeContentBlocks(next, previous as any);

    expect(normalized[0].toolUse?.result).toBe('hello world');
    expect(normalized[1].toolUse?.result).toBeUndefined();
  });
});

 describe('nested artifact regression', () => {
  it('preserves the entire body including diagrams and following text', () => {
    const body = '# Report\n\n```mermaid\nflowchart LR\n A["A"] --> B["B"]\n```\n\n## After diagram\nBody';
    const blocks = normalizeContentBlocks([{ type: 'text', text: '```tower-artifact path="work/report.md"\n' + body + '\n```' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'artifact_markdown', text: body });
  });
});

 describe('streaming artifact boundaries', () => {
  it('keeps partial inner opening fences as text and parses the final response', async () => {
    const { parseSDKMessage } = await import('./message-parser');
    const raw = '```tower-artifact path="work/report.md"\n# Report\n```mermaid\nflowchart LR\n A["A"] --> B["B"]\n```\nEnd\n```';
    for (let n = 0; n < raw.length; n++) {
      const content = [{ type: 'text', text: raw.slice(0, n) }];
      expect(normalizeContentBlocks(content, [], true).some(b => b.type === 'artifact_markdown')).toBe(false);
      expect(parseSDKMessage({ message: { content } }, true).some(b => b.type === 'artifact_markdown')).toBe(false);
    }
    const content = [{ type: 'text', text: raw }];
    expect(normalizeContentBlocks(content, [], true)[0].type).toBe('text');
    expect(normalizeContentBlocks(content)[0].type).toBe('artifact_markdown');
  });
});
