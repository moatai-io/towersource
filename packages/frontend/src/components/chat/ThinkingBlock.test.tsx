// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import { ThinkingChip } from './ThinkingBlock';
import { useChatStore } from '../../stores/chat-store';

beforeEach(async () => {
  await i18n.changeLanguage('ko');
  useChatStore.setState({
    isStreaming: false,
    sessionId: null,
    engineSessionId: null,
    messages: [],
    slashCommands: [],
    attachments: [],
    messageQueue: {},
  });
});

describe('ThinkingChip', () => {
  it('shows extracted thinking title instead of the generic thinking label', () => {
    render(
      <ThinkingChip
        text={'**Considering signature inspection**\n\nI\'m thinking about the next step.'}
        isActive={false}
        onClick={() => {}}
      />
    );

    expect(screen.getByText('Considering signature inspection')).toBeInTheDocument();
    expect(screen.queryByText(/^thinking$/i)).not.toBeInTheDocument();
  });

  it('uses the English fallback when the app language is English', async () => {
    await i18n.changeLanguage('en');

    render(
      <ThinkingChip
        text=""
        isActive={false}
        onClick={() => {}}
      />
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });
});
