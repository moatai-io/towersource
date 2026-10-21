// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSessionParticipatedByCurrentUser, loadSessionListFilters, matchesSessionListFilters, saveSessionListFilter, SESSION_LIST_FILTERS_UPDATED_EVENT } from './session-list-filters';

const chat = {
  id: 'chat-1',
  name: 'Chat',
  updatedAt: '2026-07-10T00:00:00.000Z',
  ownerUsername: 'admin',
  favorite: false,
} as any;

const agent = {
  ...chat,
  id: 'agent-1',
  label: 'agent',
  agent: { hasHumanInput: false },
} as any;

const run = {
  ...chat,
  id: 'run-1',
  label: 'task',
  name: '[task] GitHub issue #168 리서치',
} as any;

const deployment = {
  ...chat,
  id: 'deployment-1',
  label: '배포 세션',
  kind: 'deployment',
} as any;

describe('session list filters', () => {
  beforeEach(() => localStorage.clear());

  it('keeps every participated session in Latest regardless of owner or last speaker', () => {
    expect(isSessionParticipatedByCurrentUser({ ...chat, currentUserParticipated: true, lastUserUsername: 'other' }, 'admin')).toBe(true);
    expect(isSessionParticipatedByCurrentUser({ ...chat, ownerUsername: 'other', currentUserParticipated: true, lastUserUsername: 'third' }, 'admin')).toBe(true);
    expect(isSessionParticipatedByCurrentUser({ ...chat, ownerUsername: 'other', currentUserParticipated: false, lastUserUsername: 'admin' }, 'admin')).toBe(false);
    expect(isSessionParticipatedByCurrentUser(chat, '')).toBe(true);
  });

  it('defaults to chats so agent backing sessions stay out even after human input', () => {
    const filters = loadSessionListFilters();
    expect(filters.kind).toBe('chats');
    expect(matchesSessionListFilters(chat, filters, { currentUsername: 'admin', isUnread: true, isStreaming: false })).toBe(true);
    expect(matchesSessionListFilters(agent, filters, { currentUsername: 'admin', isUnread: true, isStreaming: true })).toBe(false);
    expect(matchesSessionListFilters({ ...agent, agent: { hasHumanInput: true } }, filters, { currentUsername: 'admin', isUnread: true, isStreaming: false })).toBe(false);
    expect(matchesSessionListFilters(run, filters, { currentUsername: 'admin', isUnread: true, isStreaming: false })).toBe(false);
  });

  it('keeps autonomous task sessions in a separate runs filter', () => {
    const runs = { kind: 'runs' as const, my: false, favorites: false, done: false };
    expect(matchesSessionListFilters(run, runs, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(true);
    expect(matchesSessionListFilters(chat, runs, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(false);
    expect(matchesSessionListFilters(agent, runs, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(false);
  });

  it('separates deployment sessions into the external filter and keeps them out of chats', () => {
    const chats = { kind: 'chats' as const, my: false, favorites: false, done: false };
    const external = { ...chats, kind: 'external' as const };
    const all = { ...chats, kind: 'all' as const };
    expect(matchesSessionListFilters(deployment, chats, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(false);
    expect(matchesSessionListFilters(deployment, external, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(true);
    expect(matchesSessionListFilters(chat, external, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(false);
    expect(matchesSessionListFilters(deployment, all, { currentUsername: 'admin', isUnread: false, isStreaming: false })).toBe(true);
  });

  it('applies agents, participation, favorite, and completed-to-review filters consistently', () => {
    const filters = { kind: 'agents' as const, my: true, favorites: true, done: true };
    const favoriteAgent = { ...agent, favorite: true, currentUserParticipated: true };
    expect(matchesSessionListFilters(favoriteAgent, filters, { currentUsername: 'admin', isUnread: true, isStreaming: false })).toBe(true);
    expect(matchesSessionListFilters(favoriteAgent, filters, { currentUsername: 'admin', isUnread: true, isStreaming: true })).toBe(false);
    expect(matchesSessionListFilters({ ...favoriteAgent, currentUserParticipated: false, ownerUsername: 'other' }, filters, { currentUsername: 'admin', isUnread: true, isStreaming: false })).toBe(false);
  });

  it('supports running and awaiting-user status filters without classifying awaiting as completed', () => {
    const base = { kind: 'all' as const, my: false, favorites: false, done: false };
    expect(matchesSessionListFilters(chat, { ...base, running: true }, { isUnread: false, isStreaming: true })).toBe(true);
    expect(matchesSessionListFilters(chat, { ...base, running: true }, { isUnread: false, isStreaming: false })).toBe(false);
    expect(matchesSessionListFilters(chat, { ...base, awaiting: true }, { isUnread: false, isStreaming: false, isAwaiting: true })).toBe(true);
    expect(matchesSessionListFilters(chat, { ...base, awaiting: true }, { isUnread: false, isStreaming: false, isAwaiting: false })).toBe(false);
    expect(matchesSessionListFilters(chat, { ...base, done: true }, { isUnread: true, isStreaming: false, isAwaiting: true })).toBe(false);
  });

  it('notifies mounted Latest views when a sidebar filter changes', () => {
    const listener = vi.fn();
    window.addEventListener(SESSION_LIST_FILTERS_UPDATED_EVENT, listener);
    saveSessionListFilter('kind', 'external');
    expect(localStorage.getItem('sidebar-session-kind-filter')).toBe('external');
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(SESSION_LIST_FILTERS_UPDATED_EVENT, listener);
  });
});
