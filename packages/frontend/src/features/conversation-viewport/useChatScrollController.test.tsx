// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatScrollController } from './useChatScrollController';

function Harness() {
  const scrollWrapRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const userScrolledUpRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const controller = useChatScrollController({
    activeSessionId: 's1',
    viewportMessageCount: 10,
    listMessageCount: 8,
    scrollWrapRef,
    isAtBottomRef,
    userScrolledUpRef,
    setShowJumpToLatest: setShowJump,
  });

  return (
    <div>
      <div ref={scrollWrapRef}>
        <div data-testid="virtuoso-scroller" />
      </div>
      <output data-testid="user-up">{String(userScrolledUpRef.current)}</output>
      <output data-testid="at-bottom">{String(isAtBottomRef.current)}</output>
      <output data-testid="jump">{String(showJump)}</output>
      <output data-testid="mode">{controller.conversationViewport.state.mode}</output>
      <button type="button" onClick={() => controller.markUserReadingHistory('scroll')}>history</button>
      <button type="button" onClick={() => controller.markPinnedToBottom('jump-latest')}>bottom</button>
    </div>
  );
}

describe('useChatScrollController', () => {
  it('centralizes history-reading and bottom-pinning transitions', () => {
    render(<Harness />);

    expect(screen.getByTestId('user-up').textContent).toBe('false');
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
    expect(screen.getByTestId('jump').textContent).toBe('false');

    act(() => {
      screen.getByText('history').click();
    });

    expect(screen.getByTestId('user-up').textContent).toBe('true');
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
    expect(screen.getByTestId('jump').textContent).toBe('true');
    expect(screen.getByTestId('mode').textContent).toBe('user-reading-history');

    act(() => {
      screen.getByText('bottom').click();
    });

    expect(screen.getByTestId('user-up').textContent).toBe('false');
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
    expect(screen.getByTestId('jump').textContent).toBe('false');
    expect(screen.getByTestId('mode').textContent).toBe('pinned-to-bottom');
  });
});
