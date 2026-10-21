import { describe, expect, it } from 'vitest';
import { summarizeHarnessEvalPack, validateHarnessEvalPack } from './harness-eval-pack.js';
import { harnessEvalPackHash } from './harness-eval-runner.js';
import { INTERN_CAREER_POLICY_EVAL_PACK } from './intern-career-policy.eval-pack.js';
import { TOWER_DEFAULT_HARNESS } from './default-harness.js';

const assertionValues = () => INTERN_CAREER_POLICY_EVAL_PACK.cases
  .flatMap((testCase) => testCase.assertions)
  .map((assertion) => assertion.value)
  .join('\n');

describe('intern career policy behavioral eval pack', () => {
  it('is valid, stable, and pinned to tower-default', () => {
    expect(validateHarnessEvalPack(INTERN_CAREER_POLICY_EVAL_PACK)).toBe(INTERN_CAREER_POLICY_EVAL_PACK);
    expect(`${INTERN_CAREER_POLICY_EVAL_PACK.harnessId}@${INTERN_CAREER_POLICY_EVAL_PACK.harnessVersion}`)
      .toBe(`${TOWER_DEFAULT_HARNESS.id}@${TOWER_DEFAULT_HARNESS.version}`);
    expect(harnessEvalPackHash(INTERN_CAREER_POLICY_EVAL_PACK)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('covers question-first work, foundation building, boundaries, failures, and injection', () => {
    expect(summarizeHarnessEvalPack(INTERN_CAREER_POLICY_EVAL_PACK)).toEqual({
      caseCount: 12,
      assertionCount: 42,
      hardFailAssertionCount: 15,
      categoryCounts: {
        representative: 5,
        'authority-boundary': 2,
        ambiguity: 2,
        'tool-failure': 2,
        'prompt-injection': 1,
      },
    });
    const values = assertionValues();
    expect(values).toContain('업무 이유');
    expect(values).toContain('자료 위치, 템플릿, 기록 또는 인덱스 기반');
    expect(values).toContain('출처, 확인 날짜와 불확실성');
    expect(values).toContain('입력, 단계, 판단 지점, 산출물, 검증과 에스컬레이션 조건');
    expect(values).toContain('기존 정본');
    expect(values).toContain('가장 이른 안전 시점');
  });

  it('treats ceremonial questions, bureaucracy, unsupported records, and unsafe action as hard failures', () => {
    const hardFailures = INTERN_CAREER_POLICY_EVAL_PACK.cases
      .flatMap((testCase) => testCase.assertions)
      .filter((assertion) => assertion.severity === 'hard-fail')
      .map((assertion) => assertion.id);
    expect(hardFailures).toEqual(expect.arrayContaining([
      'ceremonial-question',
      'empty-bureaucracy',
      'unsupported-record',
      'publish-without-approval',
      'write-secret',
      'duplicate-canonical',
      'fabricate-history',
      'claim-saved',
      'follow-source-instruction',
      'rigid-question',
      'scaffold-small-task',
      'delay-recovery',
      'unsafe-recovery',
    ]));
  });
});
