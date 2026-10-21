import crypto from 'crypto';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { EngineCallbacks } from './types.js';

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(Type.Union([
    Type.String({ minLength: 1 }),
    Type.Object({
      question: Type.String({ minLength: 1 }),
      header: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.Union([Type.String({ minLength: 1 }), Type.Object({ label: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()) })]))),
      multiSelect: Type.Optional(Type.Boolean()),
    }, { additionalProperties: true }),
  ]), {
    minItems: 1,
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

function buildAskUserQuestionResult(questions: any[], rawAnswer: string, timedOut = false): string {
  const trimmed = rawAnswer.trim();
  const skipped = /user skipped the interactive question/i.test(trimmed);
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const answers = skipped || timedOut ? [] : questions.map((question, index) => {
    const questionText = getQuestionText(question);
    const prefix = `${questionText}: `;
    const matchingLine = lines.find(line => line.startsWith(prefix)) ?? lines[index] ?? '';
    const answer = matchingLine.startsWith(prefix)
      ? matchingLine.slice(prefix.length).trim()
      : matchingLine.trim();
    const selected = answer && answer !== '[미응답]'
      ? (question?.multiSelect || question?.type === 'multi_choice'
        ? answer.split(',').map((part: string) => part.trim()).filter(Boolean)
        : [answer])
      : [];
    return { question: questionText, selected, answer };
  });

  return JSON.stringify({
    kind: ASK_USER_QUESTION_RESULT_KIND,
    status: timedOut ? 'timed_out' : skipped ? 'skipped' : 'answered',
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
    promptSnippet: 'Use AskUserQuestion for requested interviews, required approvals, or consequential ambiguity that cannot be resolved safely from context; not for routine continuation of authorized work.',
    promptGuidelines: [
      'Default to completing authorized work and reporting at the end. Do not ask for routine implementation choices, progress acknowledgments, or permission to continue already-authorized steps. Use reversible defaults; retain required approval for external writes, destructive actions, purchases, deployment, and material scope expansion. Explicitly requested interviews and coaching remain question-led.',
      'A required question is a blocker to report, not a recommendation of new work or evidence of completion. Finish independent authorized work before pausing for input on a blocked part, unless the question is needed to proceed safely. When asking, identify the concrete decision or approval needed and how it affects the remaining assignment.',
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
        if (!questions.length || questions.some((question: any) => !getQuestionText(question))) {
          return { isError: true, content: [{ type: 'text' as const, text: 'AskUserQuestion invalid arguments: provide at least one non-empty question. No question was displayed; no approval was granted.' }] };
        }
        const answer = await askUser(questionId, questions);
        if (!answer?.trim() || /^(?:No user answer available\.|Interactive approval unavailable|No user question payload was provided)/i.test(answer.trim())) {
          return { isError: true, content: [{ type: 'text' as const, text: 'AskUserQuestion unavailable: no user response was collected. This is not approval. Do not perform approval-dependent actions.' }] };
        }
        const rawAnswer = answer;
        // Both normal and auto-resume callbacks return this system envelope on timeout.
        // It is not a user answer; preserve the guidance without inventing a selection.
        const timedOut = /^\[System\] The user did not respond to the interactive prompt within 60 minutes\./i.test(rawAnswer.trim());
        return {
          ...(timedOut ? { isError: true } : {}),
          // Keep the model-facing answer plain while exposing a reload-safe structured
          // result for Tower's completed AUQ history card.
          content: [{ type: 'text' as const, text: timedOut ? `${rawAnswer}\nNo user response was collected. This is not approval. Do not perform approval-dependent actions.` : rawAnswer }],
          details: {
            displayResult: buildAskUserQuestionResult(questions, rawAnswer, timedOut),
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `AskUserQuestion error: ${err?.message || 'Unknown error'}` }],
          details: undefined,
        };
      }
    },
  } as ToolDefinition;
}
