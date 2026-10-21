// @vitest-environment jsdom
import React from 'react';
import type { TFunction } from 'i18next';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarSearchNotice } from './SidebarSearchNotice';

afterEach(cleanup);
const t = ((key: string) => key) as TFunction<'layout'>;
describe('Sidebar search status notice', () => {
  it('does not warn on normal or cleared searches', () => {
    render(<SidebarSearchNotice notice={null} t={t} onRetry={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it.each(['partial', 'failed'] as const)('shows a polite %s notice and retries without owning results', notice => {
    const retry = vi.fn();
    const view = render(<SidebarSearchNotice notice={notice} t={t} onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain(notice === 'partial' ? 'sessionSearchPartial' : 'sessionSearchFailed');
    fireEvent.click(screen.getByRole('button'));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<SidebarSearchNotice notice={null} t={t} onRetry={retry} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
