// @vitest-environment jsdom
import React from 'react';
import type { TFunction } from 'i18next';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarSessionsToolbar } from './SidebarSessionsToolbar';

afterEach(cleanup);
describe('Sidebar Session toolbar', () => {
  it('shows a pressed archive toggle and delegates changes without clearing search', () => {
    const toggle = vi.fn();
    const search = vi.fn();
    const props = { t: ((key: string) => key) as TFunction<'layout'>, searchInputRef: { current: null }, searchQuery: 'query', setSearchQuery: search, clearSearch: vi.fn(), filterOpen: true, setFilterOpen: vi.fn(), activeFilterLabels: [], sessionKindFilter: 'chats' as const, setKindFilter: vi.fn(), filterMy: false, filterFav: false, filterDone: false, filterRunning: false, filterAwaiting: false, filterLabels: false, includeArchived: false, toggleIncludeArchived: toggle, toggleFilter: vi.fn(), resetFilters: vi.fn() };
    const view = render(<SidebarSessionsToolbar {...props} />);
    const button = screen.getByRole('button', { name: 'includeArchivedSessions' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    view.rerender(<SidebarSessionsToolbar {...props} includeArchived activeFilterLabels={['includeArchivedSessions']} />);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'filters: includeArchivedSessions' })).toBeTruthy();
  });

  it('keeps desktop search visible but omits mobile search entirely', () => {
    const base = { t: ((key: string) => key) as TFunction<'layout'>, searchInputRef: { current: null }, searchQuery: '', setSearchQuery: vi.fn(), clearSearch: vi.fn(), filterOpen: false, setFilterOpen: vi.fn(), activeFilterLabels: [], sessionKindFilter: 'all' as const, setKindFilter: vi.fn(), filterMy: false, filterFav: false, filterDone: false, filterRunning: false, filterAwaiting: false, filterLabels: false, includeArchived: false, toggleIncludeArchived: vi.fn(), toggleFilter: vi.fn(), resetFilters: vi.fn() };

    const desktop = render(<SidebarSessionsToolbar {...base} />);
    expect(screen.getByRole('searchbox', { name: 'searchSessions' })).toBeTruthy();
    desktop.unmount();

    render(<SidebarSessionsToolbar {...base} isMobile searchQuery="tower" />);
    expect(screen.queryByRole('searchbox', { name: 'searchSessions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'searchSessions' })).toBeNull();
  });

  it('renders the mobile filter as a compact icon and hides active-filter chips', () => {
    const props = { t: ((key: string) => key) as TFunction<'layout'>, searchInputRef: { current: null }, searchQuery: '', setSearchQuery: vi.fn(), clearSearch: vi.fn(), filterOpen: false, setFilterOpen: vi.fn(), activeFilterLabels: ['favorites'], sessionKindFilter: 'all' as const, setKindFilter: vi.fn(), filterMy: false, filterFav: true, filterDone: false, filterRunning: false, filterAwaiting: false, filterLabels: false, includeArchived: false, toggleIncludeArchived: vi.fn(), toggleFilter: vi.fn(), resetFilters: vi.fn(), isMobile: true };
    render(<SidebarSessionsToolbar {...props} />);
    expect(screen.getByRole('button', { name: 'filters: favorites' })).toBeTruthy();
    expect(document.querySelector('.sidebar-sessions-toolbar')?.className).toContain('absolute right-2 top-2');
    expect(screen.queryByLabelText('activeFilters')).toBeNull();
    expect(screen.queryByText('filters')).toBeNull();
  });
});
