// Owns: Sidebar Session 목록의 필터·정렬·Project grouping 계산. Public API: buildSidebarSessionListModel. See ../README.md.
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { matchesSessionListFilters, type SessionKindFilter } from '../../../utils/session-list-filters';

export interface SidebarSessionSearchResult {
  sessionId: string;
}

export interface SidebarSessionProjectGroup {
  project: Project;
  sessions: SessionMeta[];
}

export interface SidebarSessionListModel {
  filteredSessions: SessionMeta[];
  groupedSessions: { groups: SidebarSessionProjectGroup[]; ungrouped: SessionMeta[] } | null;
  isSearching: boolean;
}

interface BuildSidebarSessionListModelInput {
  sessions: SessionMeta[];
  projects: Project[];
  searchResults: SidebarSessionSearchResult[] | null;
  searchQuery: string;
  kind: SessionKindFilter;
  filterMy: boolean;
  filterFav: boolean;
  filterDone: boolean;
  currentUsername?: string;
  unreadSessionIds: ReadonlySet<string>;
  streamingSessionIds: ReadonlySet<string>;
}

/** Mixed SQLite/ISO timestamp strings을 동일한 epoch 기준으로 비교한다. */
export function sidebarSessionTimestampMs(raw: string): number {
  return raw ? new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`).getTime() : 0;
}

/** Sidebar Session 목록과 Project grouping을 DOM이나 store 접근 없이 계산한다. */
export function buildSidebarSessionListModel(input: BuildSidebarSessionListModelInput): SidebarSessionListModel {
  const {
    sessions,
    projects,
    searchResults,
    searchQuery,
    kind,
    filterMy,
    filterFav,
    filterDone,
    currentUsername,
    unreadSessionIds,
    streamingSessionIds,
  } = input;

  let candidates: SessionMeta[];
  if (searchResults) {
    const matchedIds = new Set(searchResults.map((result) => result.sessionId));
    candidates = sessions.filter((session) => matchedIds.has(session.id));
  } else {
    candidates = [...sessions].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return sidebarSessionTimestampMs(b.updatedAt) - sidebarSessionTimestampMs(a.updatedAt);
    });
  }

  const filteredSessions = candidates.filter((session) => matchesSessionListFilters(session, {
    kind,
    my: filterMy,
    favorites: filterFav,
    done: filterDone,
  }, {
    currentUsername,
    isUnread: unreadSessionIds.has(session.id),
    isStreaming: streamingSessionIds.has(session.id),
  }));

  const isSearching = searchResults !== null || searchQuery.trim().length >= 2;
  if (isSearching) return { filteredSessions, groupedSessions: null, isSearching };

  const projectGroups = new Map<string, SidebarSessionProjectGroup>();
  const ungrouped: SessionMeta[] = [];
  for (const project of projects) projectGroups.set(project.id, { project, sessions: [] });

  for (const session of filteredSessions) {
    const group = session.projectId ? projectGroups.get(session.projectId) : undefined;
    if (group) group.sessions.push(session);
    else ungrouped.push(session);
  }

  const groups = [...projectGroups.values()].sort((a, b) => {
    const activity = (group: SidebarSessionProjectGroup) => Math.max(
      sidebarSessionTimestampMs(group.project.createdAt),
      ...group.sessions.map((session) => sidebarSessionTimestampMs(session.updatedAt)),
    );
    return activity(b) - activity(a) || a.project.sortOrder - b.project.sortOrder;
  });

  return { filteredSessions, groupedSessions: { groups, ungrouped }, isSearching };
}
