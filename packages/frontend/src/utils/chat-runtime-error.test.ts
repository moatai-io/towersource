import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { presentChatRuntimeError } from './chat-runtime-error';

describe('presentChatRuntimeError', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });

  it.each([
    ['SESSION_LIMIT', 'Too many sessions are running at once. Try again after another response finishes.'],
    ['SDK_HANG', 'The response was delayed for too long and the run was stopped. Continue to resume it.'],
    ['ACCESS_DENIED', 'You do not have permission to run this action.'],
    ['NO_SESSION_ID', 'Session connection information is unavailable. Refresh the page and try again.'],
    ['COMPACT_FAILED', 'Session cleanup could not be completed. Try again shortly.'],
  ])('maps %s to user-facing language', (code, expected) => {
    expect(presentChatRuntimeError(code).message).toBe(expected);
  });

  it('does not expose unknown provider or SDK diagnostics', () => {
    expect(presentChatRuntimeError(undefined)).toEqual({
      message: 'The response could not be completed. Continue or try again.',
      tone: 'error',
    });
  });

  it('follows the active Korean language', async () => {
    await i18n.changeLanguage('ko');
    expect(presentChatRuntimeError('ACCESS_DENIED').message).toBe('현재 권한으로 이 작업을 실행할 수 없습니다.');
    expect(presentChatRuntimeError('MODEL_NOT_SELECTABLE').message).toContain('선택한 모델');
    expect(presentChatRuntimeError('MODEL_PRESET_UNAVAILABLE').message).toContain('관리자에게 모델 매핑');
  });
});
