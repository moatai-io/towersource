import { describe, expect, it } from 'vitest';
import { presentChatRuntimeError } from './chat-runtime-error';

describe('presentChatRuntimeError', () => {
  it.each([
    ['SESSION_LIMIT', '동시에 실행할 수 있는 대화 수를 초과했습니다. 다른 응답이 끝난 뒤 다시 시도해 주세요.'],
    ['SDK_HANG', '응답이 오래 지연되어 실행을 멈췄습니다. 계속 진행하면 다시 이어갈 수 있습니다.'],
    ['ACCESS_DENIED', '현재 권한으로 이 작업을 실행할 수 없습니다.'],
    ['NO_SESSION_ID', '대화 연결 정보를 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.'],
    ['COMPACT_FAILED', '대화 내용 정리를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  ])('maps %s to user-facing language', (code, expected) => {
    expect(presentChatRuntimeError(code).message).toBe(expected);
  });

  it('does not expose unknown provider or SDK diagnostics', () => {
    expect(presentChatRuntimeError(undefined)).toEqual({
      message: '응답을 완료하지 못했습니다. 계속 진행하거나 다시 시도해 주세요.',
      tone: 'error',
    });
  });
});
