// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import { useChatStore } from '../../stores/chat-store';
import { StatusLine } from './StatusLine';

vi.mock('../layout/ModelSelector', () => ({ ModelSelector: () => <button>Model</button> }));

beforeEach(async () => {
  await i18n.changeLanguage('ko');
  useChatStore.setState({
    messages: [],
    turnStartTime: null,
    lastTurnMetrics: null,
    cost: {
      totalCost: 0, inputTokens: 0, outputTokens: 0,
      cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0,
      contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0,
    },
  });
});

describe('StatusLine', () => {
  it('leaves the live timer above the composer and preserves the model selector', () => {
    useChatStore.setState({ turnStartTime: Date.now() - 12_400 });
    render(<StatusLine isTurnActive />);
    expect(screen.queryByTestId('status-line-running-mark')).not.toBeInTheDocument();
    expect(screen.queryByTestId('status-line-turn-time')).not.toBeInTheDocument();
    expect(screen.queryByTestId('status-line-last-turn-time')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument();
  });

  it('keeps the integer-second display consistent across the minute boundary', () => {
    useChatStore.setState({ messages: [{ id: 'last', role: 'assistant', content: [], timestamp: Date.now() - 2000, durationMs: 59_900 }] });
    render(<StatusLine />);
    expect(screen.getByTestId('status-line-last-turn-time')).toHaveTextContent('59s');
  });

  it('shows persisted last assistant duration when idle and not during a new turn', () => {
    useChatStore.setState({ messages: [{ id: 'last', role: 'assistant', content: [], timestamp: Date.now() - 2000, durationMs: 87_000 }] });
    const { rerender } = render(<StatusLine />);
    expect(screen.getByTestId('status-line-last-turn-time')).toHaveTextContent('1m 27s');
    expect(screen.queryByTestId('status-line-running-mark')).not.toBeInTheDocument();
    act(() => useChatStore.setState({ turnStartTime: Date.now() - 4000 }));
    rerender(<StatusLine isTurnActive />);
    expect(screen.queryByTestId('status-line-last-turn-time')).not.toBeInTheDocument();
    expect(screen.queryByTestId('status-line-turn-time')).not.toBeInTheDocument();
  });

  it('hides the previous duration while awaiting a user answer', () => {
    useChatStore.setState({ messages: [{ id: 'last', role: 'assistant', content: [], timestamp: Date.now() - 2000, durationMs: 20_000 }] });
    render(<StatusLine isTurnActive />);
    expect(screen.queryByTestId('status-line-last-turn-time')).not.toBeInTheDocument();
  });

  it('does not leak in-memory metrics from a previous session without an assistant message', () => {
    useChatStore.setState({ lastTurnMetrics: { durationMs: 24_000, inputTokens: 0, outputTokens: 0 } });
    render(<StatusLine />);
    expect(screen.queryByTestId('status-line-last-turn-time')).not.toBeInTheDocument();
  });

  it('labels used context and shows the same percentage in the bar', () => {
    useChatStore.setState({ cost: { ...useChatStore.getState().cost, contextInputTokens: 46_000, contextWindowSize: 200_000 } });
    render(<StatusLine />);
    expect(screen.getByText('컨텍스트 23% 사용')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '23');
    expect(bar.firstElementChild).toHaveStyle({ width: '23%' });
  });

  it('does not display a price even when a live estimated cost exists', () => {
    act(() => useChatStore.setState({ cost: { ...useChatStore.getState().cost, totalCost: 0.0123, turnCount: 1 } }));
    render(<StatusLine />);
    expect(screen.queryByText(/직전 턴 추정|\$0\.0123/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument();
  });
});

it('labels Tower pressure separately from model input measurement', () => {
  useChatStore.setState({ cost: { ...useChatStore.getState().cost, contextInputTokens: 100_000, contextWindowSize: 200_000,
    contextSnapshot: { windowTokens: 200_000, pressure: { tokens: 144_000, thresholdTokens: 144_000,
      policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } } } });
  render(<StatusLine />);
  expect(screen.getByText('Tower 압축 기준 100% 사용')).toBeInTheDocument();
  expect(screen.getByTitle(/Tower 선제 압축 판단용 컨텍스트/)).toHaveTextContent('Tower 압축 기준 100% 사용');
});
