import crypto from 'crypto';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { EngineCallbacks } from './types.js';

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(Type.Any(), {
    description: 'Questions to present to the user. Keep the raw structure so ws-handler can forward it as-is.',
  }),
});

const ASK_USER_QUESTION_RESULT_KIND = 'tower.ask_user_question_result';

function getQuestionText(question: any): string {
  if (typeof question === 'string') return question.trim();
  for (const key of ['question', 'title', 'prompt', 'label']) {
    const value = question?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildAskUserQuestionResult(questions: any[], rawAnswer: string): string {
  const trimmed = rawAnswer.trim();
  const skipped = /user skipped the interactive question/i.test(trimmed);
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const answers = skipped ? [] : questions.map((question, index) => {
    const questionText = getQuestionText(question);
    const prefix = `${questionText}: `;
    const matchingLine = lines.find(line => line.startsWith(prefix)) ?? lines[index] ?? '';
    const answer = matchingLine.startsWith(prefix)
      ? matchingLine.slice(prefix.length).trim()
      : matchingLine.slice(Math.max(0, matchingLine.indexOf(': ') + 2)).trim();
    const selected = answer && answer !== '[미응답]'
      ? (question?.multiSelect || question?.type === 'multi_choice'
        ? answer.split(',').map((part: string) => part.trim()).filter(Boolean)
        : [answer])
      : [];
    return { question: questionText, selected, answer };
  });

  return JSON.stringify({
    kind: ASK_USER_QUESTION_RESULT_KIND,
    status: skipped ? 'skipped' : 'answered',
    answers,
    rawAnswer: trimmed,
  });
}

export function createAskUserQuestionTool(
  askUser: EngineCallbacks['askUser'],
): ToolDefinition {
  return {
    name: 'AskUserQuestion',
    label: 'Ask User Question',
    description: 'Pause execution for a focused interactive question and wait for the user’s answer. Use for one-at-a-time interviews, bounded choices, material clarifications, and explicit action authorization when the answer is needed before useful work can continue.',
    promptSnippet: 'Use AskUserQuestion proactively for focused interviews, bounded choices, material clarification, or immediate go/no-go authorization when the answer determines the next useful step.',
    promptGuidelines: [
      'Use AskUserQuestion proactively when the user’s answer is required before useful work can continue: one-at-a-time interviews, a small set of concrete choices, material clarification of scope/audience/direction/environment/risk, or an immediate go/no-go authorization.',
      'Ask the smallest useful question and prefer one decision at a time. Keep options concrete; include an Other path when the list is not exhaustive.',
      'For immediate go/no-go authorization, pass explicit options such as Yes/No or Approve/Cancel. Do not create a free-text question that asks the user to type only “yes”, “no”, “네”, or “아니오”.',
      'Use plain prose instead for open-ended reflection, nuanced discussion, optional questions, or when a small reversible assumption is safe. Do not manufacture user involvement when a reasonable default lets the work proceed.',
      'Pass the raw questions array so the frontend can render the existing question UI.',
    ],
    parameters: AskUserQuestionParams,

    async execute(_toolCallId: string, params: { questions?: any[] } | any) {
      try {
        const questionId = `q-${crypto.randomUUID()}`;
        const questions = Array.isArray(params?.questions)
          ? params.questions
          : (params ? [params] : []);
        const answer = await askUser(questionId, questions);
        const rawAnswer = answer || '(no answer provided)';
        return {
          // Keep the model-facing answer plain while exposing a reload-safe structured
          // result for Tower's completed AUQ history card.
          content: [{ type: 'text' as const, text: rawAnswer }],
          details: {
            displayResult: buildAskUserQuestionResult(questions, rawAnswer),
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `AskUserQuestion error: ${err?.message || 'Unknown error'}` }],
          details: undefined,
        };
      }
    },
  } as ToolDefinition;
}
