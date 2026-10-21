import { describe, expect, it, vi } from 'vitest';
import { createAskUserQuestionTool } from './pi-ask-user-tool.js';

describe('AskUserQuestion collaboration contract', () => {
  it('keeps routine continuation autonomous while preserving approvals and requested interviews', () => {
    const tool = createAskUserQuestionTool(vi.fn()) as any;
    const guidelines = tool.promptGuidelines.join('\n');
    expect(tool.promptSnippet).toContain('not for routine continuation of authorized work');
    expect(guidelines).toContain('Default to completing authorized work and reporting at the end');
    expect(guidelines).toContain('Do not ask for routine implementation choices');
    expect(guidelines).toContain('external writes, destructive actions, purchases, deployment, and material scope expansion');
    expect(guidelines).toContain('Explicitly requested interviews and coaching remain question-led');
    expect(guidelines).toContain('Yes/No or Approve/Cancel');
    expect(guidelines).toContain('include an Other path');
    expect(guidelines).toContain('A required question is a blocker to report');
    expect(guidelines).toContain('Finish independent authorized work before pausing');
    expect(guidelines).toContain('unless the question is needed to proceed safely');
    expect(guidelines).toContain('concrete decision or approval needed');
  });

  it('rejects invalid payloads before requesting user input', async () => {
    const callback = vi.fn();
    const tool = createAskUserQuestionTool(callback) as any;
    for (const questions of [[], [{}], [{ question: '   ' }]]) {
      expect((await tool.execute('invalid', { questions })).isError).toBe(true);
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it('marks unavailable callbacks and thrown errors as failures, not approval', async () => {
    for (const callback of [vi.fn().mockResolvedValue('No user answer available.'), vi.fn().mockRejectedValue(new Error('Disconnected'))]) {
      const tool = createAskUserQuestionTool(callback) as any;
      expect((await tool.execute('unavailable', { questions: [{ question: 'Approve?' }] })).isError).toBe(true);
    }
  });

  it.each([
    '[System] The user did not respond to the interactive prompt within 60 minutes. They may have switched to another session or missed it. Your question was: "Approve?". Do NOT proceed silently.',
    '[System] The user did not respond to the interactive prompt within 60 minutes. Your question was: "Approve?". Ask the same question again as a regular chat message if it is still needed.',
  ])('does not turn callback timeout guidance into an answer: %s', async (answer) => {
    const tool = createAskUserQuestionTool(vi.fn().mockResolvedValue(answer)) as any;
    const result = await tool.execute('timeout', { questions: [{ question: 'Approve?' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('This is not approval');
    expect(result.content[0].text).toContain(answer);
    expect(JSON.parse(result.details.displayResult)).toEqual({
      kind: 'tower.ask_user_question_result', status: 'timed_out', answers: [], rawAnswer: answer,
    });
  });

  it('rejects whitespace-only answers and preserves skip and ordinary answer semantics', async () => {
    const execute = async (answer: string) => {
      const tool = createAskUserQuestionTool(vi.fn().mockResolvedValue(answer)) as any;
      return tool.execute('answer', { questions: [{ question: 'Approve?' }] });
    };
    expect((await execute('  ')).isError).toBe(true);
    const skipped = await execute('[User skipped the interactive question]');
    expect(JSON.parse(skipped.details.displayResult)).toMatchObject({ status: 'skipped', answers: [] });
    for (const answer of ['Approve', 'Cancel', 'Please investigate the timeout']) {
      const result = await execute(answer);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.details.displayResult)).toMatchObject({ status: 'answered', answers: [{ answer }] });
    }
  });

  it('still pauses for a required question and passes the raw questions to the callback', async () => {
    const askUser = vi.fn().mockResolvedValue('Approve');
    const tool = createAskUserQuestionTool(askUser) as any;
    const questions = [{ question: 'Approve this action?', options: [{ label: 'Approve' }, { label: 'Cancel' }] }];
    const result = await tool.execute('approval-test', { questions });
    expect(askUser).toHaveBeenCalledWith(expect.stringMatching(/^q-/), questions);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Approve');
  });
});
