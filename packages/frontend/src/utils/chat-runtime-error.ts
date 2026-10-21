import i18n from '../i18n';

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

function runtimeErrorText(key: string): string {
  return i18n.t(`chatRuntimeError.${key}`, { ns: 'common' });
}

/** Convert a websocket chat error into stable, actionable user language. */
export function presentChatRuntimeError(errorCode?: string): ChatRuntimeErrorPresentation {
  switch (errorCode) {
    case 'RATE_LIMIT':
      return { message: runtimeErrorText('rateLimit'), tone: 'warning' };
    case 'SESSION_LIMIT':
      return { message: runtimeErrorText('sessionLimit'), tone: 'warning' };
    case 'SESSION_BUSY':
      return { message: runtimeErrorText('sessionBusy'), tone: 'warning' };
    case 'SDK_HANG':
      return { message: runtimeErrorText('sdkHang'), tone: 'warning' };
    case 'ACCESS_DENIED':
    case 'COMMAND_UNAUTHORIZED':
      return { message: runtimeErrorText('accessDenied'), tone: 'error' };
    case 'NO_SESSION_ID':
      return { message: runtimeErrorText('noSessionId'), tone: 'warning' };
    case 'COMMAND_UNSUPPORTED':
      return { message: runtimeErrorText('commandUnsupported'), tone: 'warning' };
    case 'COMPACT_FAILED':
      return { message: runtimeErrorText('compactFailed'), tone: 'warning' };
    case 'MODEL_NOT_SELECTABLE':
      return { message: runtimeErrorText('modelNotSelectable'), tone: 'error' };
    case 'MODEL_PRESET_UNAVAILABLE':
      return { message: runtimeErrorText('modelPresetUnavailable'), tone: 'error' };
    default:
      return { message: runtimeErrorText('default'), tone: 'error' };
  }
}
