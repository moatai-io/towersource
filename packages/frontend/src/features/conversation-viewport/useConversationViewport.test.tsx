// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConversationViewport } from './useConversationViewport';

function Harness({ sessionId, messageCount, streamingPulse }: { sessionId: string; messageCount: number; streamingPulse: number }) {
  const viewport = useConversationViewport({ activeSessionId: sessionId, messageCount });

  useEffect(() => {
    if (streamingPulse > 0) viewport.onStreamingStarted(1_000 + streamingPulse);
  }, [streamingPulse, viewport.onStreamingStarted]);

  return (
    <div>
      <output data-testid="mode">{viewport.state.mode}</output>
      <output data-testid="jump">{String(viewport.state.showJumpToLatest)}</output>
      <output data-testid="follow">{String(viewport.shouldAutoFollow(2_000 + streamingPulse))}</output>
      <button
        type="button"
        onClick={() => viewport.onUserScroll({ scrollTop: 300, scrollHeight: 2_000, clientHeight: 700 }, 1_100)}
      >
        scroll-history
      </button>
      <button
        type="button"
        onClick={() => viewport.onUserScroll({ scrollTop: 1_260, scrollHeight: 2_000, clientHeight: 700 }, 1_200)}
      >
        scroll-bottom
      </button>
      <button type="button" onClick={() => viewport.onJumpToLatest(messageCount, 1_300)}>
        jump-latest
      </button>
    </div>
  );
}

describe('useConversationViewport streaming scroll regression', () => {
  it('keeps auto-follow disabled when new streaming content arrives after the user scrolls up', () => {
    const { rerender } = render(<Harness sessionId="s1" messageCount={20} streamingPulse={0} />);

    expect(screen.getByTestId('follow').textContent).toBe('true');

    act(() => {
      screen.getByText('scroll-history').click();
    });

    expect(screen.getByTestId('mode').textContent).toBe('user-reading-history');
    expect(screen.getByTestId('jump').textContent).toBe('true');
    expect(screen.getByTestId('follow').textContent).toBe('false');

    rerender(<Harness sessionId="s1" messageCount={21} streamingPulse={1} />);

    expect(screen.getByTestId('mode').textContent).toBe('user-reading-history');
    expect(screen.getByTestId('jump').textContent).toBe('true');
    expect(screen.getByTestId('follow').textContent).toBe('false');
  });

  it('re-enables auto-follow only after the user returns to bottom or explicitly jumps latest', () => {
    render(<Harness sessionId="s1" messageCount={20} streamingPulse={0} />);

    act(() => {
      screen.getByText('scroll-history').click();
    });
    expect(screen.getByTestId('follow').textContent).toBe('false');

    act(() => {
      screen.getByText('scroll-bottom').click();
    });
    expect(screen.getByTestId('mode').textContent).toBe('pinned-to-bottom');
    expect(screen.getByTestId('follow').textContent).toBe('true');

    act(() => {
      screen.getByText('scroll-history').click();
    });
    expect(screen.getByTestId('follow').textContent).toBe('false');

    act(() => {
      screen.getByText('jump-latest').click();
    });
    expect(screen.getByTestId('mode').textContent).toBe('pinned-to-bottom');
    expect(screen.getByTestId('jump').textContent).toBe('false');
    expect(screen.getByTestId('follow').textContent).toBe('true');
  });
});
