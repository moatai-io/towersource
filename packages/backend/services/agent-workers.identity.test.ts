import { describe, expect, it } from 'vitest';
import { buildWorkerIdentitySnapshot } from './agent-workers.js';

describe('agent worker identity snapshot', () => {
  it('inherits the parent Primary Agent face when the Helper Agent has none', () => {
    expect(buildWorkerIdentitySnapshot({
      name: 'AUQ 변화 수정',
      role: '대기 상태 전파 검토',
      tagline: '질문 대기 상태를 놓치지 않습니다',
    }, {
      face: 'character:core-engineer',
    })).toEqual({
      name: 'AUQ 변화 수정',
      role: '대기 상태 전파 검토',
      face: 'character:core-engineer',
      tagline: '질문 대기 상태를 놓치지 않습니다',
    });
  });

  it('keeps an explicitly selected Helper Agent face over the parent face', () => {
    expect(buildWorkerIdentitySnapshot({
      name: 'QA steward',
      role: '독립 품질 검수',
      face: '🔎',
    }, {
      face: 'character:core-engineer',
    }).face).toBe('🔎');
  });

  it('keeps the neutral fallback contract when neither identity has a face', () => {
    expect(buildWorkerIdentitySnapshot({
      name: 'Temporary helper',
      role: '단기 조사',
    }, null).face).toBeUndefined();
  });
});
