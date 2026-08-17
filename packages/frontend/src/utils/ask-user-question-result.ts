// Owns AskUserQuestion result parsing for reload-safe chat history.
// New Pi results use a structured JSON envelope; older sessions remain readable from legacy "question: answer" lines.

export const ASK_USER_QUESTION_RESULT_KIND = 'tower.ask_user_question_result';

export interface AskUserQuestionHistoryAnswer {
  question: string;
  selected: string[];
  answer: string;
}

export interface AskUserQuestionHistoryResult {
  status: 'answered' | 'skipped' | 'timed_out' | 'error';
  answers: AskUserQuestionHistoryAnswer[];
  rawAnswer?: string;
}

function questionText(question: any): string {
  if (typeof question === 'string') return question.trim();
  for (const key of ['question', 'title', 'prompt', 'label']) {
    const value = question?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function optionLabels(question: any): string[] {
  if (!Array.isArray(question?.options)) return [];
  return question.options
    .map((option: any) => {
      if (typeof option === 'string') return option.trim();
      const label = typeof option?.label === 'string' ? option.label : option?.value;
      return typeof label === 'string' ? label.trim() : '';
    })
    .filter(Boolean);
}

function splitSelected(answer: string, question: any): string[] {
  const labels = optionLabels(question);
  if (!answer || answer === '[미응답]') return [];
  if (!question?.multiSelect && question?.type !== 'multi_choice') return [answer];

  const exactMatches = labels.filter(label => answer.split(',').map(part => part.trim()).includes(label));
  if (exactMatches.length > 0) {
    const custom = answer.split(',').map(part => part.trim()).filter(part => part && !labels.includes(part));
    return [...exactMatches, ...custom];
  }
  return answer.split(',').map(part => part.trim()).filter(Boolean);
}

function parseLegacyAnswer(raw: string, questions: any[]): AskUserQuestionHistoryResult {
  const trimmed = raw.trim();
  if (/user skipped the interactive question/i.test(trimmed)) {
    return { status: 'skipped', answers: [], rawAnswer: trimmed };
  }
  if (/did not respond|timed out|timeout/i.test(trimmed)) {
    return { status: 'timed_out', answers: [], rawAnswer: trimmed };
  }
  if (/askuserquestion error|session aborted/i.test(trimmed)) {
    return { status: 'error', answers: [], rawAnswer: trimmed };
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const answers = questions.map((question, index) => {
    const questionLabel = questionText(question);
    const prefix = `${questionLabel}: `;
    const matchingLine = lines.find(line => line.startsWith(prefix)) ?? lines[index] ?? '';
    const answer = matchingLine.startsWith(prefix)
      ? matchingLine.slice(prefix.length).trim()
      : matchingLine.slice(Math.max(0, matchingLine.indexOf(': ') + 2)).trim();
    return {
      question: questionLabel,
      selected: splitSelected(answer, question),
      answer,
    };
  }).filter(item => item.question || item.answer);

  return { status: 'answered', answers, rawAnswer: trimmed };
}

/** Build the same display envelope optimistically before the backend tool result arrives. */
export function buildAskUserQuestionDisplayResult(questions: any[], rawAnswer: string): string {
  const parsed = parseLegacyAnswer(rawAnswer, questions);
  return JSON.stringify({
    kind: ASK_USER_QUESTION_RESULT_KIND,
    status: parsed.status,
    answers: parsed.answers,
    rawAnswer: parsed.rawAnswer,
  });
}

/** Parse both the structured AUQ result envelope and historic plain-text results. */
export function parseAskUserQuestionResult(result: string | undefined, questions: any[]): AskUserQuestionHistoryResult | null {
  if (!result?.trim()) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed?.kind === ASK_USER_QUESTION_RESULT_KIND && Array.isArray(parsed.answers)) {
      return {
        status: ['answered', 'skipped', 'timed_out', 'error'].includes(parsed.status) ? parsed.status : 'answered',
        rawAnswer: typeof parsed.rawAnswer === 'string' ? parsed.rawAnswer : undefined,
        answers: parsed.answers.map((item: any, index: number) => {
          const question = questions[index];
          const answer = typeof item?.answer === 'string' ? item.answer : '';
          return {
            question: typeof item?.question === 'string' ? item.question : questionText(question),
            selected: Array.isArray(item?.selected)
              ? item.selected.filter((value: unknown): value is string => typeof value === 'string')
              : splitSelected(answer, question),
            answer,
          };
        }),
      };
    }
  } catch {
    // Historic results are intentionally plain text.
  }
  return parseLegacyAnswer(result, questions);
}
