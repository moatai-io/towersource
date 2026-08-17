import type { PendingQuestion } from '../stores/chat-store';

type NormalizedPendingOption = PendingQuestion['questions'][number]['options'][number];
type NormalizedPendingQuestionItem = PendingQuestion['questions'][number];

function normalizeQuestionText(q: any): string {
  if (typeof q === 'string') return q.trim();
  if (!q || typeof q !== 'object') return '';
  for (const key of ['question', 'title', 'prompt', 'label']) {
    const value = q[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

export function normalizePendingQuestion(input: {
  questionId?: string | null;
  sessionId?: string | null;
  questions?: any[] | null;
} | null | undefined): PendingQuestion | null {
  if (!input?.questionId || !input?.sessionId || !Array.isArray(input.questions)) {
    return null;
  }

  const questions: NormalizedPendingQuestionItem[] = input.questions
    .map((q): NormalizedPendingQuestionItem | null => {
      const question = normalizeQuestionText(q);
      if (!question) return null;
      const raw = q && typeof q === 'object' ? q : {};
      return {
        question,
        header: typeof raw.header === 'string' ? raw.header : undefined,
        multiSelect: !!raw.multiSelect || raw.type === 'multi_choice',
        options: Array.isArray(raw.options)
          ? (raw.options as unknown[])
              .map((opt: unknown): NormalizedPendingOption | null => {
                if (typeof opt === 'string') {
                  const label = opt.trim();
                  return label ? { label, description: undefined } : null;
                }
                if (!opt || typeof opt !== 'object') return null;
                const rawOpt = opt as { label?: unknown; value?: unknown; description?: unknown };
                const label = typeof rawOpt.label === 'string' && rawOpt.label.trim().length > 0
                  ? rawOpt.label.trim()
                  : (typeof rawOpt.value === 'string' && rawOpt.value.trim().length > 0 ? rawOpt.value.trim() : '');
                return label ? {
                  label,
                  description: typeof rawOpt.description === 'string' ? rawOpt.description : undefined,
                } : null;
              })
              .filter((opt): opt is NormalizedPendingOption => !!opt)
          : [],
      };
    })
    .filter((q): q is NormalizedPendingQuestionItem => !!q);

  if (questions.length === 0) {
    return null;
  }

  return {
    questionId: input.questionId,
    sessionId: input.sessionId,
    questions,
  };
}
