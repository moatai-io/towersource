import { useTranslation } from 'react-i18next';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { KanbanCard } from './KanbanCard';
import type { TaskMeta } from '../../stores/kanban-store';

interface KanbanColumnProps {
  id: string;
  title: string;
  color: string;
  tasks: TaskMeta[];
  onCardClick: (task: TaskMeta) => void;
  onDeleteTask: (taskId: string) => void;
  onSpawnTask: (taskId: string) => void;
  onAbortTask: (taskId: string) => void;
  onScheduleTask: (taskId: string) => void;
  onCleanupWorktree: (taskId: string) => void;
  /** Optional "+" button in column header */
  onAdd?: () => void;
}

export function KanbanColumn({ id, title, color, tasks, onCardClick, onDeleteTask, onSpawnTask, onAbortTask, onScheduleTask, onCleanupWorktree, onAdd }: KanbanColumnProps) {
  const { t } = useTranslation('kanban');
  const { setNodeRef, isOver } = useDroppable({ id });

  // Group: top-level tasks first, then child tasks nested under parents
  const topLevel = tasks.filter((t) => !t.parentTaskId);
  const childrenMap = new Map<string, TaskMeta[]>();
  for (const t of tasks) {
    if (t.parentTaskId) {
      const list = childrenMap.get(t.parentTaskId) || [];
      list.push(t);
      childrenMap.set(t.parentTaskId, list);
    }
  }

  // Build ordered list: parent followed by children
  const orderedTasks: { task: TaskMeta; isChild: boolean }[] = [];
  for (const task of topLevel) {
    orderedTasks.push({ task, isChild: false });
    const children = childrenMap.get(task.id);
    if (children) {
      for (const child of children) {
        orderedTasks.push({ task: child, isChild: true });
      }
    }
  }
  // Orphan children (parent in different column)
  for (const t of tasks) {
    if (t.parentTaskId && !topLevel.find((p) => p.id === t.parentTaskId)) {
      if (!orderedTasks.find((o) => o.task.id === t.id)) {
        orderedTasks.push({ task: t, isChild: true });
      }
    }
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-0 flex flex-col rounded-xl transition-colors ${
        isOver ? 'bg-surface-800/80 ring-1 ring-blue-500/30' : 'bg-surface-900/50'
      }`}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-surface-800">
        <span className={`text-base font-medium ${color}`}>{title}</span>
        <span className="text-sm text-gray-500 bg-surface-800 rounded-full px-2 py-0.5">
          {tasks.length}
        </span>
        {/* Spacer */}
        <span className="flex-1" />
        {/* Add button */}
        {onAdd && (
          <button
            onClick={onAdd}
            className="text-gray-500 hover:text-gray-200 transition-colors p-0.5 rounded hover:bg-surface-700/50"
            title={t('newTask')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {orderedTasks.map(({ task, isChild }) => (
            <div key={task.id} className={isChild ? 'ml-4 border-l-2 border-surface-700 pl-2' : ''}>
              <KanbanCard
                task={task}
                onClick={() => onCardClick(task)}
                onDelete={() => onDeleteTask(task.id)}
                onSpawn={(task.status === 'todo' || task.status === 'failed') ? () => onSpawnTask(task.id) : undefined}
                onAbort={task.status === 'in_progress' ? () => onAbortTask(task.id) : undefined}
                onSchedule={id === 'scheduled' ? () => onScheduleTask(task.id) : undefined}
                onCleanupWorktree={task.worktreePath && task.status !== 'in_progress' ? () => onCleanupWorktree(task.id) : undefined}
              />
            </div>
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div className="text-center text-gray-600 text-sm py-8">
            {id === 'todo' ? t('addTaskToStart') : id === 'scheduled' ? t('noScheduleYet') : t('dropCardsHere')}
          </div>
        )}
      </div>
    </div>
  );
}
