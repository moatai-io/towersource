import { describe, it, expect } from 'vitest';
import { normalizePendingQuestion } from './pending-question';

describe('normalizePendingQuestion', () => {
  it('returns null for empty question payloads', () => {
    expect(normalizePendingQuestion({
      questionId: 'q-1',
      sessionId: 's-1',
      questions: [],
    })).toBeNull();
  });

  it('drops invalid options and keeps valid questions', () => {
    expect(normalizePendingQuestion({
      questionId: 'q-1',
      sessionId: 's-1',
      questions: [
        { question: '  배포 환경을 선택해 주세요  ', options: [{ label: ' 운영 ' }, { nope: true }] },
        { question: '   ', options: [{ label: '무시' }] },
      ],
    })).toEqual({
      questionId: 'q-1',
      sessionId: 's-1',
      questions: [
        {
          question: '배포 환경을 선택해 주세요',
          header: undefined,
          multiSelect: false,
          options: [{ label: '운영', description: undefined }],
        },
      ],
    });
  });

  it('maps multi_choice payloads to multiSelect', () => {
    expect(normalizePendingQuestion({
      questionId: 'q-multi',
      sessionId: 's-1',
      questions: [
        {
          type: 'multi_choice',
          title: '복수 선택 테스트',
          options: ['맥락 복원', '메시지 작성'],
        },
      ],
    })?.questions[0].multiSelect).toBe(true);
  });

  it('accepts tool-call shaped title/value/string payloads', () => {
    expect(normalizePendingQuestion({
      questionId: 'q-2',
      sessionId: 's-1',
      questions: [
        {
          id: 'auq-test',
          type: 'single_choice',
          title: 'AskUserQuestion 카드가 보이나요?',
          options: [
            { label: '네, 보여요', value: 'yes' },
            { value: 'no' },
            '직접 입력',
          ],
        },
      ],
    })).toEqual({
      questionId: 'q-2',
      sessionId: 's-1',
      questions: [
        {
          question: 'AskUserQuestion 카드가 보이나요?',
          header: undefined,
          multiSelect: false,
          options: [
            { label: '네, 보여요', description: undefined },
            { label: 'no', description: undefined },
            { label: '직접 입력', description: undefined },
          ],
        },
      ],
    });
  });
});
