/**
 * Owns: chat runtime error presentation. Public API: presentChatRuntimeError.
 *
 * Backend error messages may contain provider, SDK, transcript, or lifecycle details.
 * This boundary keeps those diagnostics out of user-facing transcript and run-state UI.
 */

export type ChatRuntimeErrorTone = 'warning' | 'error';

export interface ChatRuntimeErrorPresentation {
  message: string;
  tone: ChatRuntimeErrorTone;
}

const DEFAULT_CHAT_ERROR_MESSAGE = '응답을 완료하지 못했습니다. 계속 진행하거나 다시 시도해 주세요.';

/** Convert a websocket chat error into stable, actionable user language. */
export function presentChatRuntimeError(errorCode?: string): ChatRuntimeErrorPresentation {
  switch (errorCode) {
    case 'RATE_LIMIT':
      return { message: '요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.', tone: 'warning' };
    case 'SESSION_LIMIT':
      return { message: '동시에 실행할 수 있는 대화 수를 초과했습니다. 다른 응답이 끝난 뒤 다시 시도해 주세요.', tone: 'warning' };
    case 'SESSION_BUSY':
      return { message: '현재 응답이 끝나면 이 요청을 이어서 보냅니다.', tone: 'warning' };
    case 'SDK_HANG':
      return { message: '응답이 오래 지연되어 실행을 멈췄습니다. 계속 진행하면 다시 이어갈 수 있습니다.', tone: 'warning' };
    case 'ACCESS_DENIED':
    case 'COMMAND_UNAUTHORIZED':
      return { message: '현재 권한으로 이 작업을 실행할 수 없습니다.', tone: 'error' };
    case 'NO_SESSION_ID':
      return { message: '대화 연결 정보를 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.', tone: 'warning' };
    case 'COMMAND_UNSUPPORTED':
      return { message: '현재 대화 엔진에서는 이 명령을 지원하지 않습니다.', tone: 'warning' };
    case 'COMPACT_FAILED':
      return { message: '대화 내용 정리를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.', tone: 'warning' };
    default:
      return { message: DEFAULT_CHAT_ERROR_MESSAGE, tone: 'error' };
  }
}
