import { describe, expect, it } from 'vitest';
import { buildAskUserQuestionDisplayResult, parseAskUserQuestionResult } from './ask-user-question-result';

const questions = [{
  question: '필요한 검증을 고르세요',
  options: [{ label: '단위 테스트' }, { label: '빌드' }, { label: '수동 확인' }],
  multiSelect: true,
}];

describe('parseAskUserQuestionResult', () => {
  it('parses structured AUQ history envelopes', () => {
    const result = parseAskUserQuestionResult(JSON.stringify({
      kind: 'tower.ask_user_question_result',
      status: 'answered',
      answers: [{ question: '필요한 검증을 고르세요', selected: ['단위 테스트', '빌드'], answer: '단위 테스트, 빌드' }],
    }), questions);

    expect(result).toMatchObject({
      status: 'answered',
      answers: [{ selected: ['단위 테스트', '빌드'] }],
    });
  });

  it('keeps legacy text results readable after reload', () => {
    const result = parseAskUserQuestionResult('필요한 검증을 고르세요: 단위 테스트, 직접 점검', questions);

    expect(result).toMatchObject({
      status: 'answered',
      answers: [{ selected: ['단위 테스트', '직접 점검'], answer: '단위 테스트, 직접 점검' }],
    });
  });

  it('builds the optimistic structured result used immediately after submit', () => {
    const built = buildAskUserQuestionDisplayResult(questions, '필요한 검증을 고르세요: 단위 테스트, 빌드');
    expect(parseAskUserQuestionResult(built, questions)).toMatchObject({
      status: 'answered',
      answers: [{ selected: ['단위 테스트', '빌드'] }],
    });
  });

  it('recognizes skipped results', () => {
    expect(parseAskUserQuestionResult('[User skipped the interactive question]', questions)).toMatchObject({
      status: 'skipped',
      answers: [],
    });
  });
});
