// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChatScrollTrace, getChatScrollTrace, traceChatScroll } from './scrollDebugTrace';

describe('scrollDebugTrace', () => {
  beforeEach(() => {
    localStorage.clear();
    clearChatScrollTrace();
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  it('does nothing unless explicitly enabled', () => {
    traceChatScroll('range-changed', { startIndex: 1 });

    expect(getChatScrollTrace()).toEqual([]);
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('records compact traces when enabled by localStorage flag', () => {
    localStorage.setItem('tower.chatScrollDebug', '1');

    traceChatScroll('range-changed', { startIndex: 1, endIndex: 2 });
    traceChatScroll('at-bottom-change', { atBottom: false });

    expect(getChatScrollTrace().map((entry) => entry.event)).toEqual(['range-changed', 'at-bottom-change']);
    expect(console.debug).toHaveBeenCalledTimes(2);
  });
});
