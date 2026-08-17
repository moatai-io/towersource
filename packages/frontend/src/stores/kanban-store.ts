import { create } from 'zustand';
export type { WorkflowMode, TaskMeta } from '@tower/shared';
import type { TaskMeta } from '@tower/shared';

interface KanbanState {
  tasks: TaskMeta[];
  loading: boolean;

  setTasks: (tasks: TaskMeta[]) => void;
  addTask: (task: TaskMeta) => void;
  updateTask: (taskId: string, updates: Partial<TaskMeta>) => void;
  removeTask: (taskId: string) => void;
  moveTask: (taskId: string, newStatus: TaskMeta['status']) => void;
  setLoading: (loading: boolean) => void;
}

export const useKanbanStore = create<KanbanState>((set) => ({
  tasks: [],
  loading: false,

  setTasks: (tasks) => set((s) => {
    // If store is empty, just set directly
    if (s.tasks.length === 0) return { tasks };
    // Merge: prefer the version with the later updatedAt to avoid HTTP fetch
    // overwriting fresher WebSocket updates (race condition protection)
    const storeMap = new Map(s.tasks.map((t) => [t.id, t]));
    const merged = tasks.map((incoming) => {
      const existing = storeMap.get(incoming.id);
      if (existing && existing.updatedAt > incoming.updatedAt) {
        return existing; // Store has a fresher version (from WS task_update)
      }
      return incoming;
    });
    return { tasks: merged };
  }),

  addTask: (task) => set((s) => {
    // Prevent duplicates (race: WS task_created vs HTTP POST response)
    if (s.tasks.some((t) => t.id === task.id)) return s;
    return { tasks: [...s.tasks, task] };
  }),

  updateTask: (taskId, updates) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId
        ? { ...t, ...updates, updatedAt: new Date().toISOString() }
        : t)),
    })),

  removeTask: (taskId) =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) })),

  moveTask: (taskId, newStatus) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: newStatus, updatedAt: new Date().toISOString() } : t
      ),
    })),

  setLoading: (loading) => set({ loading }),
}));
