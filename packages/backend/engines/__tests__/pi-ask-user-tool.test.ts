import { describe, it, expect, vi } from 'vitest';

describe('Pi AskUserQuestion tool', () => {
  it('exports createAskUserQuestionTool', async () => {
    const mod = await import('../pi-ask-user-tool.ts');
    expect(typeof mod.createAskUserQuestionTool).toBe('function');
  });

  it('prompts for focused interviews and bounded choices without encouraging needless questions', async () => {
    const { createAskUserQuestionTool } = await import('../pi-ask-user-tool.ts');
    const tool = createAskUserQuestionTool(async () => 'answer');
    const guidance = tool.promptGuidelines?.join(' ') || '';

    expect(tool.description).toContain('one-at-a-time interviews');
    expect(tool.promptSnippet).toContain('focused interviews');
    expect(guidance).toContain('material clarification of scope/audience/direction/environment/risk');
    expect(guidance).toContain('pass explicit options such as Yes/No or Approve/Cancel');
    expect(guidance).toContain('Do not create a free-text question that asks the user to type only');
    expect(guidance).toContain('Use plain prose instead for open-ended reflection');
    expect(guidance).toContain('Do not manufacture user involvement');
  });

  it('calls askUser callback with generated questionId and raw questions', async () => {
    const { createAskUserQuestionTool } = await import('../pi-ask-user-tool.ts');
    const askUser = vi.fn(async () => 'Environment: Production');
    const tool = createAskUserQuestionTool(askUser);

    const questions = [
      {
        question: 'Environment',
        options: [
          { label: 'Production' },
          { label: 'Staging' },
        ],
      },
    ];

    const result = await tool.execute('tool-1', { questions }, undefined as any);

    expect(askUser).toHaveBeenCalledTimes(1);
    const [questionId, forwardedQuestions] = askUser.mock.calls[0];
    expect(questionId).toEqual(expect.any(String));
    expect(questionId.length).toBeGreaterThan(0);
    expect(forwardedQuestions).toEqual(questions);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Environment: Production');
    expect(JSON.parse((result.details as any).displayResult)).toEqual({
      kind: 'tower.ask_user_question_result',
      status: 'answered',
      answers: [{
        question: 'Environment',
        selected: ['Production'],
        answer: 'Production',
      }],
      rawAnswer: 'Environment: Production',
    });
  });

  it('wraps direct question-shaped params for compatibility', async () => {
    const { createAskUserQuestionTool } = await import('../pi-ask-user-tool.ts');
    const askUser = vi.fn(async () => '보임');
    const tool = createAskUserQuestionTool(askUser);

    await tool.execute('tool-1', { title: '카드가 보이나요?', options: ['보임', '안 보임'] }, undefined as any);

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0][1]).toEqual([{ title: '카드가 보이나요?', options: ['보임', '안 보임'] }]);
  });

  it('records skipped interactive questions as a structured display result', async () => {
    const { createAskUserQuestionTool } = await import('../pi-ask-user-tool.ts');
    const tool = createAskUserQuestionTool(async () => '[User skipped the interactive question]');

    const result = await tool.execute('tool-1', { questions: [{ question: 'Confirm?' }] }, undefined as any);

    expect(JSON.parse((result.details as any).displayResult)).toMatchObject({
      kind: 'tower.ask_user_question_result',
      status: 'skipped',
      answers: [],
    });
  });

  it('returns error text when askUser callback rejects', async () => {
    const { createAskUserQuestionTool } = await import('../pi-ask-user-tool.ts');
    const tool = createAskUserQuestionTool(async () => {
      throw new Error('Session aborted');
    });

    const result = await tool.execute('tool-1', { questions: [{ question: 'Confirm?' }] }, undefined as any);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Session aborted');
  });
});
