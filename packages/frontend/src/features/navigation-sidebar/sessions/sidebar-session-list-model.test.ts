import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { buildSidebarSessionListModel } from './sidebar-session-list-model';

const project = (id: string, createdAt: string, sortOrder = 0): Project => ({ id, name: id, createdAt, sortOrder } as Project);
const session = (id: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  name: id,
  cwd: '/workspace',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  favorite: false,
  ownerUsername: 'alice',
  ...overrides,
} as SessionMeta);

const base = {
  projects: [project('old', '2026-07-01T00:00:00Z'), project('new', '2026-08-09T00:00:00Z')],
  searchResults: null,
  searchQuery: '',
  kind: 'all' as const,
  filterMy: false,
  filterFav: false,
  filterDone: false,
  currentUsername: 'alice',
  unreadSessionIds: new Set<string>(),
  streamingSessionIds: new Set<string>(),
};

describe('buildSidebarSessionListModel', () => {
  it('sorts favorites first and then by recent activity without mutating input', () => {
    const sessions = [
      session('recent', { updatedAt: '2026-08-10T00:00:00Z' }),
      session('favorite', { favorite: true, updatedAt: '2026-08-01T00:00:00Z' }),
      session('middle', { updatedAt: '2026-08-05 00:00:00' }),
    ];
    const model = buildSidebarSessionListModel({ ...base, sessions });
    expect(model.filteredSessions.map((item) => item.id)).toEqual(['favorite', 'recent', 'middle']);
    expect(sessions.map((item) => item.id)).toEqual(['recent', 'favorite', 'middle']);
  });

  it('keeps search result order based on the existing sessions array and disables grouping', () => {
    const model = buildSidebarSessionListModel({
      ...base,
      sessions: [session('a'), session('b'), session('c')],
      searchResults: [{ sessionId: 'c' }, { sessionId: 'a' }],
    });
    expect(model.filteredSessions.map((item) => item.id)).toEqual(['a', 'c']);
    expect(model.groupedSessions).toBeNull();
    expect(model.isSearching).toBe(true);
  });

  it('applies owner, favorite, done and streaming boundaries together', () => {
    const model = buildSidebarSessionListModel({
      ...base,
      sessions: [
        session('keep', { favorite: true }),
        session('streaming', { favorite: true }),
        session('other', { favorite: true, ownerUsername: 'bob' }),
        session('plain'),
      ],
      filterMy: true,
      filterFav: true,
      filterDone: true,
      unreadSessionIds: new Set(['keep', 'streaming', 'other']),
      streamingSessionIds: new Set(['streaming']),
    });
    expect(model.filteredSessions.map((item) => item.id)).toEqual(['keep']);
  });

  it('keeps empty projects, groups matching sessions and sends stale project references to ungrouped', () => {
    const model = buildSidebarSessionListModel({
      ...base,
      sessions: [
        session('old-session', { projectId: 'old', updatedAt: '2026-08-10T00:00:00Z' }),
        session('stale', { projectId: 'deleted' }),
        session('personal'),
      ],
    });
    expect(model.groupedSessions?.groups.map((group) => group.project.id)).toEqual(['old', 'new']);
    expect(model.groupedSessions?.groups[0].sessions.map((item) => item.id)).toEqual(['old-session']);
    expect(model.groupedSessions?.groups[1].sessions).toEqual([]);
    expect(model.groupedSessions?.ungrouped.map((item) => item.id)).toEqual(['stale', 'personal']);
  });

  it('treats a two-character query as searching before results arrive', () => {
    const model = buildSidebarSessionListModel({ ...base, sessions: [], searchQuery: 'ab' });
    expect(model.isSearching).toBe(true);
    expect(model.groupedSessions).toBeNull();
  });
});
