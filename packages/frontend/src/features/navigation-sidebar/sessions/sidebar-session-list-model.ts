// Owns: Sidebar Session 목록의 필터·정렬·Project grouping 계산. Public API: buildSidebarSessionListModel. See ../README.md.
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { isSessionParticipatedByCurrentUser, matchesSessionListFilters, type SessionKindFilter, type SessionListFilters } from '../../../utils/session-list-filters';
import { isLatestSessionDismissed } from '../../../utils/latest-session-persistence';

export interface SidebarLatestQuickSessionsInput {
  sessions: SessionMeta[];
  dismissedKeys: Set<string>;
  selectedProjectId: string | null;
  filters: SessionListFilters;
  currentUsername?: string;
  unreadSessionIds: ReadonlySet<string>;
  streamingSessionIds: ReadonlySet<string>;
  awaitingSessionIds: ReadonlySet<string>;
}

/** Top recent list uses the same filters as the full list, plus its own participation boundary. */
export function buildSidebarLatestQuickSessions(input: SidebarLatestQuickSessionsInput): SessionMeta[] {
  const { sessions, dismissedKeys, selectedProjectId, filters, currentUsername, unreadSessionIds, streamingSessionIds, awaitingSessionIds } = input;
  return sessions
    .filter((session) => isSessionParticipatedByCurrentUser(session, currentUsername)
      && !isLatestSessionDismissed(dismissedKeys, session)
      && (!selectedProjectId || session.projectId === selectedProjectId)
      && matchesSessionListFilters(session, filters, {
        currentUsername,
        isUnread: unreadSessionIds.has(session.id),
        isStreaming: streamingSessionIds.has(session.id),
        isAwaiting: awaitingSessionIds.has(session.id),
      }))
    .sort((a, b) => sidebarSessionTimestampMs(b.updatedAt) - sidebarSessionTimestampMs(a.updatedAt));
}

export interface SidebarSessionSearchResult {
  sessionId: string;
  rank?: number;
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
  filterRunning: boolean;
  filterAwaiting: boolean;
  currentUsername?: string;
  unreadSessionIds: ReadonlySet<string>;
  streamingSessionIds: ReadonlySet<string>;
  awaitingSessionIds: ReadonlySet<string>;
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
    filterRunning,
    filterAwaiting,
    currentUsername,
    unreadSessionIds,
    streamingSessionIds,
    awaitingSessionIds,
  } = input;

  let candidates: SessionMeta[];
  if (searchResults) {
    // Preserve backend relevance order while collapsing memory/session/message
    // hits that point to the same session.
    const order = new Map<string, number>();
    for (const result of searchResults) {
      if (!order.has(result.sessionId)) order.set(result.sessionId, order.size);
    }
    candidates = sessions
      .filter((session) => order.has(session.id))
      .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
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
    running: filterRunning,
    awaiting: filterAwaiting,
  }, {
    currentUsername,
    isUnread: unreadSessionIds.has(session.id),
    isStreaming: streamingSessionIds.has(session.id),
    isAwaiting: awaitingSessionIds.has(session.id),
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
