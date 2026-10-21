import { beforeEach, describe, expect, it, vi } from 'vitest';

const runUtilityTextTask = vi.fn();
vi.mock('../ai/utility-agent.js', () => ({ runUtilityTextTask }));
vi.mock('../../config.js', () => ({ getModelDefaults: () => ({ ai_reply: 'test-model' }), resolveLegacyPiModelId: (model: string) => model }));

const { applyApprovedRanges, generateApprovedRangeReplacements } = await import('./multi-range-edit.js');
import { ScopedEditError } from './scoped-source-edit.js';

const content = `.cta { color: gray; }\n.cta:hover { color: black; }\n.other { color: red; }`;

function target(source: string) {
  const start = content.indexOf(source);
  return {
    path: '/workspace/project/styles.css',
    kind: 'stylesheet-rule' as const,
    start,
    end: start + source.length,
    lineStart: 1,
    lineEnd: 1,
    source,
    selector: source.startsWith('.cta:hover') ? '.cta:hover' : '.cta',
    confidence: 'related' as const,
  };
}

describe('generateApprovedRangeReplacements', () => {
  beforeEach(() => runUtilityTextTask.mockReset());

  it('returns the model-authored message when no approved range changes', async () => {
    const selected = target('.cta { color: gray; }');
    runUtilityTextTask.mockResolvedValue(JSON.stringify({
      replacements: [{ id: 'target-0', replacement: selected.source }],
      message: '이미 요청하신 문구로 되어 있어 변경하지 않았습니다.',
    }));

    const result = await generateApprovedRangeReplacements({
      instruction: '이 문구를 그대로 유지해줘',
      targets: [selected],
    });

    expect(result.replacements[0].replacement).toBe(selected.source);
    expect(result.message).toBe('이미 요청하신 문구로 되어 있어 변경하지 않았습니다.');
    expect(runUtilityTextTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('If every replacement is unchanged, explain naturally why no edit was needed'),
    }));
  });

  it('uses same-session conversation as context without expanding writable ranges', async () => {
    const selected = target('.cta { color: gray; }');
    runUtilityTextTask.mockResolvedValue(JSON.stringify({
      replacements: [{ id: 'target-0', replacement: '.cta { color: blue; }' }],
      message: '앞서 정한 파란색 방향에 맞춰 버튼 색을 변경했습니다.',
    }));

    await generateApprovedRangeReplacements({
      instruction: '아까 말한 방향으로 바꿔줘',
      conversationContext: 'User: 파란색을 유지해줘.\n\nAssistant: 이후 수정에서도 파란색을 유지하겠습니다.',
      targets: [selected],
    });

    expect(runUtilityTextTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Conversation context from this same session'),
      systemPrompt: expect.stringContaining('it never grants file authority'),
    }));
    const prompt = runUtilityTextTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('파란색을 유지해줘');
    expect(prompt).toContain('Approved source ranges (the only writable ranges)');
    expect(prompt).toContain('아까 말한 방향으로 바꿔줘');
  });
});

describe('applyApprovedRanges', () => {
  it('replaces multiple non-overlapping ranges without touching surrounding CSS', () => {
    const next = applyApprovedRanges(content, [
      { target: target('.cta { color: gray; }'), replacement: '.cta { color: blue; }' },
      { target: target('.cta:hover { color: black; }'), replacement: '.cta:hover { color: navy; }' },
    ]);
    expect(next).toBe(`.cta { color: blue; }\n.cta:hover { color: navy; }\n.other { color: red; }`);
  });

  it('rejects stale source text', () => {
    const stale = { ...target('.cta { color: gray; }'), source: '.cta { color: green; }' };
    expect(() => applyApprovedRanges(content, [{ target: stale, replacement: '.cta { color: blue; }' }]))
      .toThrowError(ScopedEditError);
  });

  it('rejects overlapping ranges', () => {
    const first = target('.cta { color: gray; }');
    const overlap = { ...first, start: first.start + 2, source: content.slice(first.start + 2, first.end) };
    expect(() => applyApprovedRanges(content, [
      { target: first, replacement: first.source },
      { target: overlap, replacement: overlap.source },
    ])).toThrowError(ScopedEditError);
  });
});
