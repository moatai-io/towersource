import type { SessionMeta } from '@tower/shared';
import { getSessionPresentationKind } from '../features/agent-sessions/classification';

export type SessionKindFilter = 'all' | 'chats' | 'agents' | 'runs' | 'external';

export interface SessionListFilters {
  kind: SessionKindFilter;
  my: boolean;
  favorites: boolean;
  done: boolean;
  running?: boolean;
  awaiting?: boolean;
}

export const SESSION_LIST_FILTERS_UPDATED_EVENT = 'tower:session-list-filters-updated';

/** Latest includes every accessible session the current user owns or has spoken in. */
export function isSessionParticipatedByCurrentUser(session: SessionMeta, currentUsername?: string): boolean {
  if (!currentUsername) return true;
  return session.currentUserParticipated ?? session.ownerUsername === currentUsername;
}


/** Load the persisted sidebar session filters shared by the main and Latest lists. */
export function loadSessionListFilters(): SessionListFilters {
  if (typeof localStorage === 'undefined') {
    return { kind: 'chats', my: false, favorites: false, done: false, running: false, awaiting: false };
  }
  const storedKind = localStorage.getItem('sidebar-session-kind-filter');
  return {
    kind: storedKind === 'all' || storedKind === 'agents' || storedKind === 'runs' || storedKind === 'external' ? storedKind : 'chats',
    my: localStorage.getItem('sidebar-filter-my') === 'true',
    favorites: localStorage.getItem('sidebar-filter-fav') === 'true',
    done: localStorage.getItem('sidebar-filter-done') === 'true',
    running: localStorage.getItem('sidebar-filter-running') === 'true',
    awaiting: localStorage.getItem('sidebar-filter-awaiting') === 'true',
  };
}

/** Persist one filter and notify other mounted session views in the same browser tab. */
export function saveSessionListFilter(key: 'kind' | 'my' | 'favorites' | 'done' | 'running' | 'awaiting', value: SessionKindFilter | boolean): void {
  if (typeof localStorage === 'undefined') return;
  const storageKey = key === 'kind'
    ? 'sidebar-session-kind-filter'
    : `sidebar-filter-${key === 'favorites' ? 'fav' : key}`;
  localStorage.setItem(storageKey, String(value));
  window.dispatchEvent(new CustomEvent(SESSION_LIST_FILTERS_UPDATED_EVENT));
}

/** Apply the user-selected session filters consistently to any session list. */
export function matchesSessionListFilters(
  session: SessionMeta,
  filters: SessionListFilters,
  options: { currentUsername?: string; isUnread: boolean; isStreaming: boolean; isAwaiting?: boolean },
): boolean {
  const presentationKind = getSessionPresentationKind(session);
  if (filters.kind !== 'all' && filters.kind !== 'external' && presentationKind === 'deployment') return false;
  if (filters.kind === 'agents' && presentationKind !== 'agent') return false;
  if (filters.kind === 'runs' && presentationKind !== 'run') return false;
  if (filters.kind === 'external' && presentationKind !== 'deployment') return false;
  if (filters.kind === 'chats' && presentationKind !== 'chat') return false;
  if (filters.my && !isSessionParticipatedByCurrentUser(session, options.currentUsername)) return false;
  if (filters.favorites && !session.favorite) return false;
  if (filters.running && !options.isStreaming) return false;
  if (filters.awaiting && !options.isAwaiting) return false;
  if (filters.done && (!options.isUnread || options.isStreaming || options.isAwaiting)) return false;
  return true;
}
