import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TaskMeta } from '../../stores/kanban-store';
import { useProjectStore } from '../../stores/project-store';
import { RunIndicator } from '../common/RunIndicator';

interface KanbanCardProps {
  task: TaskMeta;
  onClick: () => void;
  isDragOverlay?: boolean;
  onDelete?: () => void;
  onSpawn?: () => void;
  onAbort?: () => void;
  onSchedule?: () => void;
  onCleanupWorktree?: () => void;
}

const WORKFLOW_BADGE: Record<string, { cls: string; label: string }> = {
  simple: { cls: 'tone-pill tone-success', label: 'Simple' },
  default: { cls: 'bg-blue-900/40 text-blue-400', label: 'Default' },
  feature: { cls: 'bg-orange-900/40 text-orange-400', label: 'Feature' },
  big_task: { cls: 'bg-red-900/40 text-red-400', label: 'Big Task' },
};

/** Human-friendly time-until string */
function formatTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'overdue';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

/** Human-friendly recurring label */
function formatCronLabel(json: string | null): string | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json);
    const pad = (n: number) => String(n).padStart(2, '0');
    switch (c.type) {
      case 'daily': return `Daily ${pad(c.hour ?? 9)}:${pad(c.minute ?? 0)}`;
      case 'weekdays': return `Weekdays ${pad(c.hour ?? 9)}:${pad(c.minute ?? 0)}`;
      case 'weekly': {
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        return `${days[c.day ?? 1]} ${pad(c.hour ?? 9)}:${pad(c.minute ?? 0)}`;
      }
      case 'interval': return `Every ${c.hours ?? 1}h`;
      default: return null;
    }
  } catch { return null; }
}

const STATUS_STYLES: Record<string, { badge: string; border: string }> = {
  todo: { badge: 'bg-gray-700 text-gray-300', border: 'border-surface-700' },
  in_progress: { badge: 'bg-blue-900/50 text-blue-300', border: 'border-blue-500/30' },
  done: { badge: 'tone-pill tone-success', border: 'tone-success tone-border' },
  failed: { badge: 'bg-red-900/50 text-red-300', border: 'border-red-500/30' },
};

function CardMoreMenu({ task, onSchedule, onCleanupWorktree, onDelete, isScheduled, isRecurring, t, isTouchDevice }: {
  task: TaskMeta;
  onSchedule?: () => void;
  onCleanupWorktree?: () => void;
  onDelete?: () => void;
  isScheduled: boolean;
  isRecurring: boolean;
  t: (key: string) => string;
  isTouchDevice: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);


  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  const hasActions = onSchedule || (onCleanupWorktree && task.worktreePath && task.status !== 'in_progress') || (onDelete && task.status !== 'in_progress');
  if (!hasActions) return null;

  const itemClass = "w-full min-h-[44px] flex items-center gap-3 px-4 py-2 text-[15px] hover:bg-surface-700 transition-colors text-left";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`text-gray-500 hover:text-gray-200 transition-all rounded hover:bg-surface-700/50 ${isTouchDevice ? 'grid h-10 w-10 place-items-center' : 'p-1'}`}
        title="More actions"
        aria-label="More actions"
      >
        <svg className={isTouchDevice ? 'w-4 h-4' : 'w-3.5 h-3.5'} fill="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {open && (
        <div
          className={isTouchDevice
            ? "fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] z-50 max-h-[70vh] overflow-y-auto overscroll-contain bg-surface-800 border border-surface-700 rounded-2xl shadow-2xl py-2"
            : "absolute right-0 top-full mt-1 w-44 bg-surface-800 border border-surface-700 rounded-lg shadow-xl z-50 py-1 overflow-hidden"
          }
          onClick={(e) => e.stopPropagation()}>
          {onSchedule && (
            <button className={`${itemClass} ${isScheduled ? (isRecurring ? 'text-purple-400' : 'tone-warning tone-text') : 'text-gray-300'}`}
              onClick={() => { onSchedule(); setOpen(false); }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {isScheduled ? t('editSchedule') : t('schedule')}
            </button>
          )}
          {onCleanupWorktree && task.worktreePath && task.status !== 'in_progress' && (
            <button className={`${itemClass} text-orange-400`} onClick={() => { onCleanupWorktree(); setOpen(false); }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t('cleanWorktree')}
            </button>
          )}
          {onDelete && task.status !== 'in_progress' && (
            <>
              <div className="border-t border-surface-700/50 my-1" />
              <button className={`${itemClass} text-red-400`} onClick={() => { onDelete(); setOpen(false); }}>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {t('common:delete')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function KanbanCard({ task, onClick, isDragOverlay, onDelete, onSpawn, onAbort, onSchedule, onCleanupWorktree }: KanbanCardProps) {
  const { t } = useTranslation('kanban');
  const isTouchDevice = useRef(typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const styles = STATUS_STYLES[task.status] || STATUS_STYLES.todo;
  const lastProgress = task.progressSummary?.[task.progressSummary.length - 1] || '';
  const isScheduled = task.scheduleEnabled && !!task.scheduledAt;
  const isRecurring = !!task.scheduleCron;
  const cronLabel = formatCronLabel(task.scheduleCron);
  const projectName = useProjectStore((s) => {
    if (!task.projectId) return null;
    return s.projects.find(p => p.id === task.projectId)?.name ?? null;
  });

  return (
    <div
      ref={!isDragOverlay ? setNodeRef : undefined}
      style={!isDragOverlay ? style : undefined}
      {...(!isDragOverlay && !isTouchDevice.current ? { ...attributes, ...listeners } : {})}
      onClick={onClick}
      className={`
        group p-3 rounded-lg border cursor-pointer transition-all
        bg-surface-850 hover:bg-surface-800
        ${styles.border}
        ${isScheduled ? (isRecurring ? 'border-l-2 border-l-purple-500' : 'tone-warning border-l-2 border-l-[var(--tone-text)]') : ''}
        ${isDragging ? 'opacity-40' : ''}
        ${isDragOverlay ? 'shadow-xl shadow-black/50 rotate-2' : ''}
      `}
    >
      {/* Title */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-medium text-gray-200 line-clamp-2">{task.title}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {task.status === 'in_progress' && (
            <RunIndicator size="xs" label="태스크 실행 중" className="mt-0.5 text-blue-400" />
          )}
          {task.status === 'done' && (
            <span className="tone-success tone-text text-sm mt-0.5">&#10003;</span>
          )}
          {task.status === 'failed' && (
            <span className="text-red-400 text-sm mt-0.5">&#10007;</span>
          )}
        </div>
      </div>

      {/* Description preview */}
      {task.description && (
        <p className="text-sm text-gray-500 mt-1 line-clamp-2">{task.description}</p>
      )}

      {/* Schedule indicator */}
      {isScheduled && (
        <div className={`mt-1.5 flex items-center gap-1 text-[12px] ${isRecurring ? 'text-purple-400' : 'tone-warning tone-text'}`}>
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="truncate">
            {isRecurring && cronLabel ? cronLabel : formatTimeUntil(task.scheduledAt!)}
            {isRecurring && task.scheduledAt && ` · next ${formatTimeUntil(task.scheduledAt)}`}
          </span>
        </div>
      )}

      {/* Progress summary */}
      {task.status === 'in_progress' && lastProgress && (
        <div className="mt-2 flex items-center gap-1.5">
          <div className="flex-1 h-1 bg-surface-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, (task.progressSummary.length / 5) * 100)}%` }}
            />
          </div>
          <span className="text-[12px] text-gray-500 shrink-0 max-w-[80px] truncate">{lastProgress}</span>
        </div>
      )}

      {/* Footer: CWD + model + time + actions */}
      <div className="mt-2 flex items-center justify-between text-[12px] text-gray-600">
        <div className="flex items-center gap-1.5 truncate max-w-[60%]">
          <span className="truncate" title={projectName ? `${projectName} · ${task.cwd}` : task.cwd}>
            {projectName || task.cwd.split('/').pop()}
          </span>
          {task.model && (
            <span className={`shrink-0 px-1 py-0.5 rounded text-[11px] ${task.model.includes('opus') ? 'bg-purple-900/40 text-purple-400' : 'bg-sky-900/40 text-sky-400'}`}>
              {task.model.includes('opus') ? 'Opus' : 'Sonnet'}
            </span>
          )}
          {task.workflow && task.workflow !== 'auto' && WORKFLOW_BADGE[task.workflow] && (
            <span className={`shrink-0 px-1 py-0.5 rounded text-[11px] ${WORKFLOW_BADGE[task.workflow].cls}`}>
              {WORKFLOW_BADGE[task.workflow].label}
            </span>
          )}
          {task.worktreePath && (
            <span className="shrink-0 text-[11px] text-orange-400" title={`Worktree: ${task.worktreePath}`}>
              <svg className="w-3 h-3 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </span>
          )}
          {task.creatorName && (
            <span
              className="shrink-0 px-1.5 py-0.5 rounded text-[11px] bg-surface-700/60 text-gray-400 font-medium"
              title={`Created by ${task.creatorName}`}
            >
              @{task.creatorName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span>{new Date(task.createdAt).toLocaleDateString()}</span>
          {/* Run button — always visible for todo/failed */}
          {onSpawn && (
            <button
              onClick={(e) => { e.stopPropagation(); onSpawn(); }}
              className={`text-blue-400 hover:text-blue-300 transition-all rounded hover:bg-blue-500/10 ${isTouchDevice.current ? 'grid h-9 w-9 place-items-center' : 'p-0.5'}`}
              title={task.status === 'failed' ? t('common:retry') : t('run')}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {task.status === 'failed' ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                ) : (
                  <>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </>
                )}
              </svg>
            </button>
          )}
          {/* Abort button — always visible when running */}
          {onAbort && (
            <button
              onClick={(e) => { e.stopPropagation(); onAbort(); }}
              className={`tone-warning tone-text hover:text-[var(--tone-text)] transition-all rounded ${isTouchDevice.current ? 'grid h-9 w-9 place-items-center' : ''}`}
              title={t('cancelTask')}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h6v4H9z" />
              </svg>
            </button>
          )}
          {/* More menu — touch accessible */}
          <CardMoreMenu
            task={task}
            onSchedule={onSchedule}
            onCleanupWorktree={onCleanupWorktree}
            onDelete={onDelete}
            isScheduled={isScheduled}
            isRecurring={isRecurring}
            t={t}
            isTouchDevice={isTouchDevice.current}
          />
        </div>
      </div>

      {/* Todo snapshot preview (for done/failed/in_progress with todos) */}
      {Array.isArray(task.todoSnapshot) && task.todoSnapshot.length > 0 && (
        <div className="mt-2">
          <div className="space-y-0.5">
            {task.todoSnapshot.slice(0, 4).map((todo, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[13px]">
                <span className="shrink-0 mt-0.5">
                  {todo.status === 'completed' ? (
                    <svg className="tone-success tone-text w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" fillOpacity="0.15" stroke="currentColor" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
                    </svg>
                  ) : todo.status === 'in_progress' ? (
                    <svg className="w-3 h-3 text-blue-400 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" />
                      <circle cx="12" cy="12" r="3" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" />
                    </svg>
                  )}
                </span>
                <span className={`truncate ${todo.status === 'completed' ? 'text-gray-500 line-through' : todo.status === 'in_progress' ? 'text-blue-300' : 'text-gray-400'}`}>
                  {todo.content}
                </span>
              </div>
            ))}
            {task.todoSnapshot.length > 4 && (
              <span className="text-[12px] text-gray-600 pl-4.5">+{task.todoSnapshot.length - 4} more</span>
            )}
          </div>
          {/* Progress bar */}
          {(() => {
            const completed = task.todoSnapshot!.filter(t => t.status === 'completed').length;
            const total = task.todoSnapshot!.length;
            return (
              <div className="mt-1.5 flex items-center gap-1.5">
                <div className="flex-1 h-1 bg-surface-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${completed === total ? 'tone-success tone-bg' : 'bg-blue-500'}`}
                    style={{ width: `${(completed / total) * 100}%` }}
                  />
                </div>
                <span className={`text-[12px] shrink-0 ${completed === total ? 'tone-success tone-text' : 'text-gray-500'}`}>
                  {completed}/{total}
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Stage pills (for done/failed, only when no todo snapshot) */}
      {!task.todoSnapshot && (task.status === 'done' || task.status === 'failed') && task.progressSummary.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.progressSummary.slice(1, -1).map((stage, i) => (
            <span key={i} className={`text-[12px] px-1.5 py-0.5 rounded ${styles.badge}`}>
              {stage}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
