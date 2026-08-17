import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { useKanbanStore, type TaskMeta } from '../../stores/kanban-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { KanbanColumn } from './KanbanColumn';
import { KanbanCard } from './KanbanCard';
import { NewTaskModal } from './NewTaskModal';
import { SchedulePopover } from './SchedulePopover';

/**
 * 2-column layout:
 *   Left:  할 일 (top) + 스케줄 (bottom)
 *   Right: 진행 중 (top) + 완료 (bottom)
 */
/**
 * 2-column layout:
 *   Left:  할 일 (top) + 스케줄 (bottom)
 *   Right: 진행 중 (top) + 완료 (bottom)
 */

export function KanbanBoard() {
  const { t } = useTranslation('kanban');
  const { tasks, setTasks, setLoading } = useKanbanStore();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeProjectId = sessions.find((s) => s.id === activeSessionId)?.projectId ?? null;
  const projects = useProjectStore((s) => s.projects);
  const [activeTask, setActiveTask] = useState<TaskMeta | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskMeta | null>(null);
  const [scheduleTaskId, setScheduleTaskId] = useState<string | null>(null);
  /** When true, opening SchedulePopover right after creating a new task */
  const [openScheduleAfterCreate, setOpenScheduleAfterCreate] = useState(false);
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const activeProjects = useMemo(() => projects.filter(p => !p.archived), [projects]);

  // Load tasks on mount
  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/tasks', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
    } catch (err) {
      console.error('Failed to load tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  // Apply project filter
  const filteredTasks = useMemo(() => {
    if (!filterProjectId) return tasks;
    return tasks.filter(t => t.projectId === filterProjectId);
  }, [tasks, filterProjectId]);

  // ── Split tasks into 4 groups ──

  /** Manual todos (no schedule or schedule disabled) */
  const todoTasks = useMemo(() => {
    return filteredTasks
      .filter(t => t.status === 'todo' && !(t.scheduleEnabled && t.scheduleCron))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [filteredTasks]);

  /** Scheduled (recurring cron, regardless of status=todo) */
  const scheduledTasks = useMemo(() => {
    return filteredTasks
      .filter(t => t.scheduleCron && t.status === 'todo')
      .sort((a, b) => {
        // Enabled first, then by sortOrder
        if (a.scheduleEnabled !== b.scheduleEnabled) return a.scheduleEnabled ? -1 : 1;
        return a.sortOrder - b.sortOrder;
      });
  }, [filteredTasks]);

  /** Running */
  const runningTasks = useMemo(() => {
    return filteredTasks
      .filter(t => t.status === 'in_progress')
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [filteredTasks]);

  /** Done + Failed */
  const doneTasks = useMemo(() => {
    return filteredTasks
      .filter(t => t.status === 'done' || t.status === 'failed')
      .sort((a, b) => {
        const aTime = a.completedAt || a.updatedAt;
        const bTime = b.completedAt || b.updatedAt;
        return bTime.localeCompare(aTime);
      });
  }, [filteredTasks]);

  // ── Drag & Drop (keep existing logic, resolve to correct column) ──

  const [overColumnId, setOverColumnId] = useState<string | null>(null);

  /** Returns [status, isScheduleSection] */
  const resolveTarget = (overId: string | number): [TaskMeta['status'] | null, boolean] => {
    const id = String(overId);
    if (id === 'scheduled') return ['todo', true];
    if (id === 'todo') return ['todo', false];
    if (id === 'in_progress' || id === 'running') return ['in_progress', false];
    if (id === 'done') return ['done', false];
    // Check if overId is a task in the scheduled section
    const overTask = tasks.find((t) => t.id === id);
    if (overTask) {
      const isInScheduled = overTask.scheduleCron && overTask.status === 'todo';
      return [overTask.status, !!isInScheduled];
    }
    return [null, false];
  };

  const resolveTargetColumn = (overId: string | number): TaskMeta['status'] | null => {
    return resolveTarget(overId)[0];
  };

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    setOverColumnId(over ? resolveTargetColumn(over.id) : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    const taskId = active.id as string;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) { setOverColumnId(null); return; }

    const [targetStatus, isScheduleTarget] = over ? resolveTarget(over.id) : [overColumnId as TaskMeta['status'] | null, false];
    setOverColumnId(null);

    // Dropped on schedule section → open schedule popover
    if (isScheduleTarget && task.status === 'todo') {
      setScheduleTaskId(taskId);
      return;
    }

    if (!targetStatus || task.status === targetStatus) return;

    if (targetStatus === 'in_progress' && (task.status === 'todo' || task.status === 'failed')) {
      onSpawnTask(taskId);
    } else if (targetStatus === 'todo' && task.status === 'in_progress') {
      onAbortTask(taskId);
    }
  };

  const onSpawnTask = (taskId: string) => {
    const ws = (window as any).__towerWs;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'task_spawn', taskId }));
    }
  };

  const onAbortTask = (taskId: string) => {
    const ws = (window as any).__towerWs;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'task_abort', taskId }));
    }
  };

  const handleCardClick = (task: TaskMeta) => {
    if (task.sessionId) {
      const { setActiveView } = useSessionStore.getState();
      setActiveView('chat');
      window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId: task.sessionId } }));
    } else if (task.status === 'todo' || task.status === 'failed') {
      setEditingTask(task);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        useKanbanStore.getState().removeTask(taskId);
      }
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const handleScheduleSave = async (schedule: {
    scheduledAt: string | null;
    scheduleCron: string | null;
    scheduleEnabled: boolean;
  }) => {
    if (!scheduleTaskId) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/tasks/${scheduleTaskId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(schedule),
      });
      if (res.ok) {
        const updated = await res.json();
        useKanbanStore.getState().updateTask(scheduleTaskId, updated);
      }
    } catch (err) {
      console.error('Failed to save schedule:', err);
    }
    setScheduleTaskId(null);
  };

  const handleCleanupWorktree = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/tasks/${taskId}/cleanup-worktree`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        useKanbanStore.getState().updateTask(taskId, { worktreePath: null });
      }
    } catch (err) {
      console.error('Failed to cleanup worktree:', err);
    }
  };

  const scheduleTask = scheduleTaskId ? tasks.find((t) => t.id === scheduleTaskId) : null;

  // Shared column props
  const columnProps = {
    onCardClick: handleCardClick,
    onDeleteTask: handleDeleteTask,
    onSpawnTask,
    onAbortTask,
    onScheduleTask: (taskId: string) => setScheduleTaskId(taskId),
    onCleanupWorktree: handleCleanupWorktree,
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-4">
      {/* Board header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-gray-200">{t('layout:task')}</h2>
          <div className="flex items-center gap-1.5">
            <select
              value={filterProjectId ?? ''}
              onChange={(e) => setFilterProjectId(e.target.value || null)}
              className="text-sm bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer max-w-[180px]"
            >
              <option value="">{t('allProjects')}</option>
              {activeProjects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {filterProjectId && (
              <button
                onClick={() => setFilterProjectId(null)}
                className="text-gray-500 hover:text-gray-300 transition-colors p-1"
                title={t('clearFilter')}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <button
          onClick={() => setShowNewTask(true)}
          className="px-3 py-1.5 text-base bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          + {t('newTask')}
        </button>
      </div>

      {/* 2-column layout */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 flex flex-col sm:flex-row gap-4 min-h-0">
          {/* ── Left column: 할 일 + 스케줄 ── */}
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col gap-3">
            {/* 할 일 */}
            <KanbanColumn
              id="todo"
              title={t('todo')}
              color="text-gray-400"
              tasks={todoTasks}
              {...columnProps}
              onAdd={() => setShowNewTask(true)}
            />

            {/* 스케줄 */}
            <KanbanColumn
              id="scheduled"
              title={t('schedule')}
              color="tone-warning tone-text"
              tasks={scheduledTasks}
              {...columnProps}
              onAdd={() => { setOpenScheduleAfterCreate(true); setShowNewTask(true); }}
            />
          </div>

          {/* ── Right column: 진행 중 + 완료 ── */}
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col gap-3">
            {/* 진행 중 */}
            <KanbanColumn
              id="in_progress"
              title={t('inProgress')}
              color="text-blue-400"
              tasks={runningTasks}
              {...columnProps}
            />

            {/* 완료 */}
            <KanbanColumn
              id="done"
              title={t('done')}
              color="tone-success tone-text"
              tasks={doneTasks}
              {...columnProps}
            />
          </div>
        </div>

        <DragOverlay>
          {activeTask ? (
            <KanbanCard task={activeTask} isDragOverlay onClick={() => {}} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Schedule Popover */}
      {scheduleTask && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <SchedulePopover
            taskId={scheduleTask.id}
            currentScheduledAt={scheduleTask.scheduledAt}
            currentScheduleCron={scheduleTask.scheduleCron}
            currentScheduleEnabled={scheduleTask.scheduleEnabled}
            onSave={handleScheduleSave}
            onClose={() => setScheduleTaskId(null)}
          />
        </div>
      )}

      {showNewTask && (
        <NewTaskModal
          onClose={() => { setShowNewTask(false); setOpenScheduleAfterCreate(false); }}
          onCreated={(task) => {
            useKanbanStore.getState().addTask(task);
            setShowNewTask(false);
            if (openScheduleAfterCreate) {
              setOpenScheduleAfterCreate(false);
              // Open schedule popover right after task creation
              setScheduleTaskId(task.id);
            }
          }}
          projectId={filterProjectId || activeProjectId}
          filterProjectId={filterProjectId}
        />
      )}

      {editingTask && (
        <NewTaskModal
          editTask={editingTask}
          onClose={() => setEditingTask(null)}
          onCreated={(updated) => {
            useKanbanStore.getState().updateTask(updated.id, updated);
            setEditingTask(null);
          }}
        />
      )}
    </div>
  );
}
