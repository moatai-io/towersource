import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore, type SessionMeta } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { type TaskMeta } from '../../stores/kanban-store';
import { toastSuccess, toastError } from '../../utils/toast';
import { useConfirm } from '../../hooks/useDialog';

type HistoryTab = 'sessions' | 'tasks';
type SessionViewMode = 'recent' | 'grouped';

interface ArchivedSession extends SessionMeta {}
interface ArchivedTask extends TaskMeta {}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function relativeTime(dateStr: string): string {
  let normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  if (!normalized.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(normalized)) normalized += 'Z';
  const now = Date.now();
  const then = new Date(normalized).getTime();
  if (isNaN(then)) return '';
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    done: 'tone-pill tone-success',
    failed: 'bg-red-500/15 text-red-400',
    todo: 'bg-gray-500/15 text-gray-400',
    in_progress: 'bg-blue-500/15 text-blue-400',
  };
  return (
    <span className={`text-[11px] font-medium px-1 py-px rounded ${colors[status] || colors.todo}`}>
      {status === 'in_progress' ? 'wip' : status}
    </span>
  );
}

export function HistoryPanel() {
  const { t } = useTranslation('history');
  const confirm = useConfirm();
  const [tab, setTab] = useState<HistoryTab>('sessions');
  const [viewMode, setViewMode] = useState<SessionViewMode>('recent');
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [tasks, setTasks] = useState<ArchivedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const activeView = useSessionStore((s) => s.activeView);
  const sidebarTab = useSessionStore((s) => s.sidebarTab);
  const projects = useProjectStore((s) => s.projects);

  const projectMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/history', { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
        setTasks(data.tasks || []);
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === 'history' || sidebarTab === 'history') loadHistory();
  }, [activeView, sidebarTab, loadHistory]);

  const handleRestoreSession = async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${id}/restore`, { method: 'POST', headers: getAuthHeaders() });
      if (res.ok) {
        const restored = sessions.find((s) => s.id === id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (restored) useSessionStore.getState().addSession(restored);
        toastSuccess(t('sessionRestored'));
      }
    } catch { toastError(t('failedToRestore')); }
  };

  const handleDeleteSessionPermanent = async (id: string) => {
    const ok = await confirm({
      title: t('deletePermanently'),
      message: t('deleteSessionPermanentConfirm'),
      confirmLabel: t('deletePermanently'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/sessions/${id}/permanent`, { method: 'DELETE', headers: getAuthHeaders() });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        toastSuccess(t('permanentlyDeleted'));
      }
    } catch { toastError(t('failedToDelete')); }
  };

  const handleRestoreTask = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/restore`, { method: 'POST', headers: getAuthHeaders() });
      if (res.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== id));
        toastSuccess(t('taskRestored'));
      }
    } catch { toastError(t('failedToRestoreTask')); }
  };

  const handleDeleteTaskPermanent = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/permanent`, { method: 'DELETE', headers: getAuthHeaders() });
      if (res.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== id));
        toastSuccess(t('permanentlyDeleted'));
      }
    } catch { toastError(t('failedToDelete')); }
  };

  const handleSessionClick = (session: ArchivedSession) => {
    if (!useSessionStore.getState().sessions.find((s) => s.id === session.id)) {
      useSessionStore.getState().addSession(session);
    }
    window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId: session.id } }));
  };

  const filteredSessions = searchQuery
    ? sessions.filter((s) => s.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : sessions;

  const filteredTasks = searchQuery
    ? tasks.filter((t) => t.title.toLowerCase().includes(searchQuery.toLowerCase()) || t.description.toLowerCase().includes(searchQuery.toLowerCase()))
    : tasks;

  // Group sessions by project (for "By Project" view).
  // Sort groups by most-recent session's updatedAt so the project you just
  // deleted from floats to the top. Ungrouped sessions show as "No project".
  const groupedSessions = useMemo(() => {
    const groups = new Map<string | null, ArchivedSession[]>();
    for (const s of filteredSessions) {
      const key = s.projectId || null;
      const list = groups.get(key) || [];
      list.push(s);
      groups.set(key, list);
    }
    const sorted: { projectId: string | null; name: string; sessions: ArchivedSession[]; mostRecent: number }[] = [];
    for (const [pid, list] of groups) {
      // API already returns updated_at DESC, but sort defensively inside each group
      list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      const mostRecent = list[0]?.updatedAt ? new Date(list[0].updatedAt).getTime() : 0;
      sorted.push({
        projectId: pid,
        name: pid ? (projectMap.get(pid) || 'Unknown project') : 'No project',
        sessions: list,
        mostRecent,
      });
    }
    // Most recently-touched group first
    sorted.sort((a, b) => b.mostRecent - a.mostRecent);
    return sorted;
  }, [filteredSessions, projectMap]);

  // Flat list sorted by most-recent first (for "Recent" view).
  // API returns updated_at DESC already, but sort defensively in case the
  // store ever reorders them.
  const recentSessions = useMemo(() => {
    return [...filteredSessions].sort(
      (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
  }, [filteredSessions]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Single row renderer — reused by Recent and By Project views.
  // In Recent mode, `showProjectBadge` adds the project name so you can still
  // tell where a session came from without the group header.
  const renderSessionRow = (session: ArchivedSession, showProjectBadge: boolean) => {
    const projectLabel = session.projectId
      ? (projectMap.get(session.projectId) || 'Unknown project')
      : 'No project';
    return (
      <div
        key={session.id}
        onClick={() => handleSessionClick(session)}
        className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-800/60 transition-colors cursor-pointer"
      >
        <div className="flex-1 min-w-0">
          <div className="text-[14px] text-gray-400 truncate">{session.name}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[11px] text-surface-600">{relativeTime(session.updatedAt)}</span>
            {showProjectBadge && (
              <span className="text-[11px] text-surface-600 bg-surface-800 px-1 py-px rounded truncate max-w-[120px]">
                {projectLabel}
              </span>
            )}
            {session.turnCount ? <span className="text-[11px] text-surface-700">{session.turnCount}t</span> : null}
            {session.totalCost > 0 && <span className="text-[11px] text-surface-700">${session.totalCost.toFixed(2)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); handleRestoreSession(session.id); }}
            className="tone-success p-1 rounded hover:bg-surface-700 text-surface-600 hover:text-[var(--tone-text)] transition-colors"
            title={t('restore')}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDeleteSessionPermanent(session.id); }}
            className="p-1 rounded hover:bg-surface-700 text-surface-600 hover:text-red-400 transition-colors"
            title={t('deletePermanently')}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Compact header */}
      <div className="px-3 pt-2 pb-1">
        {/* Search */}
        <div className="relative mb-1.5">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={t('searchHistory')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface-800 border border-surface-700 rounded-md text-[14px] text-gray-300 pl-8 pr-3 py-1.5 placeholder-surface-700 outline-none focus:border-primary-500/50 transition-colors"
          />
        </div>

        {/* Tab switcher — compact */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('sessions')}
            className={`px-2 py-0.5 rounded text-[12px] font-medium transition-colors ${
              tab === 'sessions'
                ? 'bg-primary-600/20 text-primary-400'
                : 'text-surface-600 hover:text-gray-400 hover:bg-surface-800'
            }`}
          >
            {t('sessionsCount', { count: sessions.length })}
          </button>
          <button
            onClick={() => setTab('tasks')}
            className={`px-2 py-0.5 rounded text-[12px] font-medium transition-colors ${
              tab === 'tasks'
                ? 'bg-primary-600/20 text-primary-400'
                : 'text-surface-600 hover:text-gray-400 hover:bg-surface-800'
            }`}
          >
            {t('tasksCount', { count: tasks.length })}
          </button>

          {/* View mode toggle — only relevant for Sessions tab */}
          {tab === 'sessions' && (
            <div className="ml-auto flex gap-0.5 bg-surface-800 rounded p-0.5">
              <button
                onClick={() => setViewMode('recent')}
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  viewMode === 'recent'
                    ? 'bg-surface-700 text-gray-300'
                    : 'text-surface-600 hover:text-gray-400'
                }`}
                title={t('sortByRecent')}
              >
                Recent
              </button>
              <button
                onClick={() => setViewMode('grouped')}
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  viewMode === 'grouped'
                    ? 'bg-surface-700 text-gray-300'
                    : 'text-surface-600 hover:text-gray-400'
                }`}
                title={t('groupByProject')}
              >
                By project
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-surface-700 border-t-primary-400 rounded-full animate-spin" />
          </div>
        ) : tab === 'sessions' ? (
          filteredSessions.length === 0 ? (
            <p className="text-[13px] text-surface-600 text-center py-8">
              {searchQuery ? t('noMatchingSessions') : t('noArchivedSessions')}
            </p>
          ) : viewMode === 'recent' ? (
            /* Flat list, sorted by most recent. Project shown as a badge. */
            <div className="mt-1 space-y-0.5">
              {recentSessions.map((session) => renderSessionRow(session, true))}
            </div>
          ) : (
            /* Grouped by project, groups ordered by most-recent session. */
            <div className="mt-1">
              {groupedSessions.map(({ projectId, name, sessions: groupSessions }) => {
                const key = projectId || '__no_project__';
                const collapsed = collapsedGroups.has(key);
                return (
                  <div key={key} className="mb-1">
                    {/* Project group header */}
                    <button
                      onClick={() => toggleGroup(key)}
                      className="w-full flex items-center gap-1.5 px-1 py-1 group"
                    >
                      <svg className={`w-3 h-3 text-surface-600 transition-transform ${collapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="text-[12px] text-surface-600 font-medium truncate">{name}</span>
                      <span className="text-[11px] text-surface-700">({groupSessions.length})</span>
                    </button>
                    {/* Session items */}
                    {!collapsed && (
                      <div className="space-y-0.5">
                        {groupSessions.map((session) => renderSessionRow(session, false))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          /* Tasks tab */
          filteredTasks.length === 0 ? (
            <p className="text-[13px] text-surface-600 text-center py-8">
              {searchQuery ? t('noMatchingTasks') : t('noArchivedTasks')}
            </p>
          ) : (
            <div className="space-y-0.5 mt-1">
              {filteredTasks.map((task) => (
                <div
                  key={task.id}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-800/60 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[14px] text-gray-400 truncate">{task.title}</span>
                      <StatusBadge status={task.status} />
                    </div>
                    {task.description && (
                      <p className="text-[12px] text-surface-600 truncate mt-0.5">{task.description}</p>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[11px] text-surface-700">{relativeTime(task.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => handleRestoreTask(task.id)}
                      className="tone-success p-1 rounded hover:bg-surface-700 text-surface-600 hover:text-[var(--tone-text)] transition-colors"
                      title={t('restore')}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDeleteTaskPermanent(task.id)}
                      className="p-1 rounded hover:bg-surface-700 text-surface-600 hover:text-red-400 transition-colors"
                      title={t('deletePermanently')}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
