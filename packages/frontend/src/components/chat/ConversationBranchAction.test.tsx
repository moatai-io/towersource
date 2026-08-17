// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ConversationBranchAction } from './ConversationBranchAction';

describe('ConversationBranchAction', () => {
  it('renders only the edit icon entry point and delegates editing to the parent bubble', () => {
    const onEditRequested = vi.fn();

    render(<ConversationBranchAction sessionId="source" messageId="message-2" onEditRequested={onEditRequested} />);

    const edit = screen.getByRole('button', { name: '수정' });
    expect(edit.getAttribute('title')).toBe('수정');
    expect(edit).toHaveClass('md:min-w-fit', 'md:shrink-0');
    const label = screen.getByText('수정');
    expect(label).toHaveClass('whitespace-nowrap');
    expect(screen.queryByRole('button', { name: '같은 요청으로 새 대화 분기' })).toBeNull();

    fireEvent.click(edit);

    expect(onEditRequested).toHaveBeenCalledTimes(1);
  });
});
