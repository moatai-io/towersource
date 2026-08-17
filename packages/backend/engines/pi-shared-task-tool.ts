/**
 * Shared TaskList tools for Pi — file-based task queue for multi-agent collaboration.
 *
 * Inspired by Claude Code's Shared TaskList pattern:
 *   - Agents share a task queue via filesystem JSON + file locks
 *   - Workers "pull" tasks (not pushed) — no idle time
 *   - Verification nudge after 3+ completed tasks
 *
 * Hierarchical TaskLists:
 *   Each layer of the fork hierarchy manages its own abstraction level:
 *     PM layer     → "project-x"              → big picture tasks
 *     Senior layer → "project-x/frontend"     → module-level tasks
 *     Junior layer → "project-x/frontend/auth" → implementation details
 *
 *   Tasks can link to a subtaskListId. When ALL tasks in the sub-list complete,
 *   the parent task is auto-rolled-up to "completed".
 *
 * Design:
 *   .pi/tasks/{taskListId}/
 *     ├── hwm.json          # High Water Mark (next ID counter)
 *     ├── 1.json            # { id: 1, title, status, subtaskListId?, ... }
 *     ├── 2.json
 *     └── ...
 *
 * Concurrency: proper-lockfile with 30 retries, 5-100ms backoff.
 * Supports ~10+ concurrent agents safely.
 */

import fs from 'fs';
import path from 'path';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
// @ts-ignore -- no types available
import lockfile from 'proper-lockfile';

// ── Types ──

interface SharedTask {
  id: number;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  owner?: string;
  result?: string;
  /** Link to a sub-TaskList that breaks this task into finer details.
   *  E.g. task #1 in "project-x" → subtaskListId: "project-x/frontend"
   *  When ALL tasks in "project-x/frontend" complete, this task auto-completes. */
  subtaskListId?: string;
  createdAt: string;
  updatedAt: string;
}

interface HWM {
  nextId: number;
}

// ── File lock options (Claude Code uses same config) ──

const LOCK_OPTS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
  stale: 10000, // consider lock stale after 10s (safety net for crashed agents)
};

// ── Helpers ──

function getTaskDir(taskListId: string): string {
  return path.join(process.cwd(), '.pi', 'tasks', taskListId);
}

function ensureTaskDir(taskListId: string): string {
  const dir = getTaskDir(taskListId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getHWMPath(dir: string): string {
  return path.join(dir, 'hwm.json');
}

function getTaskPath(dir: string, id: number): string {
  return path.join(dir, `${id}.json`);
}

/** Read HWM with lock, increment, write back. Returns the new ID. */
async function allocateId(dir: string): Promise<number> {
  const hwmPath = getHWMPath(dir);

  // Ensure hwm.json exists before locking
  if (!fs.existsSync(hwmPath)) {
    fs.writeFileSync(hwmPath, JSON.stringify({ nextId: 1 }));
  }

  const release = await lockfile.lock(hwmPath, LOCK_OPTS);
  try {
    const hwm: HWM = JSON.parse(fs.readFileSync(hwmPath, 'utf8'));
    const id = hwm.nextId;
    hwm.nextId = id + 1;
    fs.writeFileSync(hwmPath, JSON.stringify(hwm));
    return id;
  } finally {
    await release();
  }
}

/** Read a single task with lock */
async function readTask(dir: string, id: number): Promise<SharedTask | null> {
  const taskPath = getTaskPath(dir, id);
  if (!fs.existsSync(taskPath)) return null;

  const release = await lockfile.lock(taskPath, LOCK_OPTS);
  try {
    return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } finally {
    await release();
  }
}

/** Write a single task with lock */
async function writeTask(dir: string, task: SharedTask): Promise<void> {
  const taskPath = getTaskPath(dir, task.id);

  // Ensure file exists before locking (proper-lockfile needs it)
  if (!fs.existsSync(taskPath)) {
    fs.writeFileSync(taskPath, '{}');
  }

  const release = await lockfile.lock(taskPath, LOCK_OPTS);
  try {
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  } finally {
    await release();
  }
}

/** Read all tasks in a directory (no lock needed — individual reads are atomic enough) */
function readAllTasks(dir: string): SharedTask[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f));
  const tasks: SharedTask[] = [];
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (task.id) tasks.push(task);
    } catch { /* skip corrupted files */ }
  }
  return tasks.sort((a, b) => a.id - b.id);
}

// ── Rollup: when a sub-list completes, auto-complete the parent task ──

/**
 * Check if taskListId is a sub-list (contains "/"), and if all its tasks are done,
 * find and complete the parent task that links to it.
 *
 * Example: "project-x/frontend" completes →
 *   find task in "project-x" where subtaskListId === "project-x/frontend" →
 *   mark it completed with rollup summary.
 */
async function rollupIfComplete(taskListId: string): Promise<string | null> {
  const dir = getTaskDir(taskListId);
  const tasks = readAllTasks(dir);
  if (tasks.length === 0) return null;

  // Check if ALL tasks in this list are completed
  const allDone = tasks.every(t => t.status === 'completed');
  if (!allDone) return null;

  // Find parent list: "project-x/frontend" → parent is "project-x"
  const lastSlash = taskListId.lastIndexOf('/');
  if (lastSlash === -1) return null; // top-level list, no parent

  const parentListId = taskListId.slice(0, lastSlash);
  const parentDir = getTaskDir(parentListId);
  if (!fs.existsSync(parentDir)) return null;

  // Find the parent task that links to this sub-list
  const parentTasks = readAllTasks(parentDir);
  const parentTask = parentTasks.find(t => t.subtaskListId === taskListId);
  if (!parentTask || parentTask.status === 'completed') return null;

  // Auto-complete the parent task with a rollup summary
  const summaries = tasks
    .filter(t => t.result)
    .map(t => `  - ${t.title}: ${t.result}`)
    .join('\n');
  parentTask.status = 'completed';
  parentTask.result = `[Auto-rollup] All ${tasks.length} subtasks completed:\n${summaries}`;
  parentTask.updatedAt = new Date().toISOString();
  await writeTask(parentDir, parentTask);

  const msg = `🔄 Rollup: "${taskListId}" fully complete → parent task #${parentTask.id} in "${parentListId}" auto-completed.`;
  console.log(`[Pi:SharedTask] ${msg}`);

  // Recursive: if parent list is also now fully complete, rollup further
  const furtherRollup = await rollupIfComplete(parentListId);

  return furtherRollup ? `${msg}\n${furtherRollup}` : msg;
}

// ═══════════════════════════════════════════════════════════════
// Tool 1: SharedTaskCreate — add tasks to the shared queue
// ═══════════════════════════════════════════════════════════════

const CreateParams = Type.Object({
  taskListId: Type.String({
    description:
      'Unique identifier for this shared task list. ' +
      'Use hierarchical names for layered work: "project-x" (PM level), ' +
      '"project-x/frontend" (Senior level), "project-x/frontend/auth" (Junior level). ' +
      'All agents at the same level must use the same taskListId.',
  }),
  parentRef: Type.Optional(Type.Object({
    taskListId: Type.String({ description: 'Parent task list that contains the task being decomposed' }),
    taskId: Type.Number({ description: 'Task ID in the parent list that this sub-list breaks down' }),
  }, {
    description:
      'Link this sub-list to a parent task. When ALL tasks in this list complete, ' +
      'the parent task auto-completes with a rollup summary. ' +
      'E.g. Senior creates "project-x/frontend" as breakdown of task #1 in "project-x".',
  })),
  tasks: Type.Array(
    Type.Object({
      title: Type.String({ description: 'Short task title (imperative form, e.g. "Implement auth middleware")' }),
      description: Type.Optional(Type.String({ description: 'Detailed description of what to do and acceptance criteria' })),
      priority: Type.Optional(Type.Union([
        Type.Literal('high'),
        Type.Literal('medium'),
        Type.Literal('low'),
      ], { description: 'Task priority. High-priority tasks should be picked first. Default: medium' })),
    }),
    { description: 'One or more tasks to add to the shared queue' },
  ),
});

export const sharedTaskCreateTool: ToolDefinition = {
  name: 'SharedTaskCreate',
  label: 'Shared Task Create',
  description:
    'Add tasks to a shared task queue that multiple agents can pull from. ' +
    'Use this to break down work into parallel tasks before forking worker agents. ' +
    'Workers call SharedTaskList to find available tasks, then SharedTaskUpdate to claim and complete them.',
  promptSnippet: 'Create tasks in a shared queue for parallel agent collaboration.',
  promptGuidelines: [
    'Use SharedTaskCreate to break down a complex task into smaller, independent units of work.',
    'Each task should be self-contained — a worker agent should be able to complete it without depending on other tasks.',
    'Use hierarchical taskListIds for layered delegation: "project-x" (PM), "project-x/frontend" (Senior), "project-x/frontend/auth" (Junior).',
    'Use parentRef to link a sub-list to a parent task — when all subtasks complete, the parent task auto-completes.',
    'Example: PM creates task #1 "Build frontend" in "project-x". Senior decomposes it by creating "project-x/frontend" with parentRef: { taskListId: "project-x", taskId: 1 }.',
    'Low-ID tasks are picked first by workers, so order tasks by dependency (prerequisites first).',
    'After creating tasks, fork worker agents with fork=true and tell them the taskListId.',
  ],
  parameters: CreateParams,

  async execute(_toolCallId: string, params: {
    taskListId: string;
    parentRef?: { taskListId: string; taskId: number };
    tasks: Array<{ title: string; description?: string; priority?: string }>;
  }) {
    try {
      const dir = ensureTaskDir(params.taskListId);
      const created: SharedTask[] = [];
      const now = new Date().toISOString();

      for (const t of params.tasks) {
        const id = await allocateId(dir);
        const task: SharedTask = {
          id,
          title: t.title,
          description: t.description,
          status: 'pending',
          priority: (t.priority as SharedTask['priority']) || 'medium',
          createdAt: now,
          updatedAt: now,
        };
        await writeTask(dir, task);
        created.push(task);
      }

      // Link parent task → this sub-list (for auto-rollup)
      let parentLink = '';
      if (params.parentRef) {
        const parentDir = getTaskDir(params.parentRef.taskListId);
        const parentTask = await readTask(parentDir, params.parentRef.taskId);
        if (parentTask) {
          parentTask.subtaskListId = params.taskListId;
          parentTask.status = 'in_progress';
          parentTask.updatedAt = now;
          await writeTask(parentDir, parentTask);
          parentLink = `\nLinked to parent: "${params.parentRef.taskListId}" task #${params.parentRef.taskId} → when all subtasks complete, parent auto-completes.`;
        }
      }

      const summary = created.map(t => `  #${t.id} [${t.priority}] ${t.title}`).join('\n');
      console.log(`[Pi:SharedTask] Created ${created.length} tasks in "${params.taskListId}"${params.parentRef ? ` (child of ${params.parentRef.taskListId}#${params.parentRef.taskId})` : ''}`);

      return {
        content: [{
          type: 'text' as const,
          text: `Created ${created.length} task(s) in shared list "${params.taskListId}":\n${summary}${parentLink}\n\nWorkers can now call SharedTaskList to find available tasks.`,
        }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `SharedTaskCreate error: ${err.message}` }],
        details: undefined,
      };
    }
  },
} as ToolDefinition;

// ═══════════════════════════════════════════════════════════════
// Tool 2: SharedTaskUpdate — claim, complete, or release a task
// ═══════════════════════════════════════════════════════════════

const UpdateParams = Type.Object({
  taskListId: Type.String({ description: 'The shared task list identifier' }),
  id: Type.Number({ description: 'Task ID to update' }),
  status: Type.Optional(Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
  ], { description: 'New status. Set to in_progress to claim, completed when done, pending to release.' })),
  owner: Type.Optional(Type.String({
    description: 'Agent name claiming this task. Set when changing status to in_progress.',
  })),
  result: Type.Optional(Type.String({
    description: 'Summary of what was done. Set when marking completed.',
  })),
});

export const sharedTaskUpdateTool: ToolDefinition = {
  name: 'SharedTaskUpdate',
  label: 'Shared Task Update',
  description:
    'Update a task in the shared queue — claim it (in_progress), complete it, or release it (back to pending). ' +
    'After completing a task, call SharedTaskList to find the next available one.',
  promptSnippet: 'Claim or complete tasks in the shared queue.',
  promptGuidelines: [
    'Before starting work, claim the task: SharedTaskUpdate(id, status="in_progress", owner="your-name").',
    'After finishing, complete it: SharedTaskUpdate(id, status="completed", result="summary of what was done").',
    'Then IMMEDIATELY call SharedTaskList to find your next available task.',
    'If you cannot complete a task, release it: SharedTaskUpdate(id, status="pending") so another agent can take it.',
    'Work on tasks in ID order (low to high) — earlier tasks may provide context for later ones.',
  ],
  parameters: UpdateParams,

  async execute(_toolCallId: string, params: {
    taskListId: string;
    id: number;
    status?: string;
    owner?: string;
    result?: string;
  }) {
    try {
      const dir = getTaskDir(params.taskListId);
      const task = await readTask(dir, params.id);
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `Task #${params.id} not found in "${params.taskListId}".` }],
          details: undefined,
        };
      }

      // Apply updates
      if (params.status) task.status = params.status as SharedTask['status'];
      if (params.owner !== undefined) task.owner = params.owner;
      if (params.result !== undefined) task.result = params.result;
      task.updatedAt = new Date().toISOString();

      await writeTask(dir, task);

      // ── Verification nudge (Claude Code pattern) ──
      // After 3+ completed tasks with no "verification" task, nudge the agent.
      const allTasks = readAllTasks(dir);
      const completedCount = allTasks.filter(t => t.status === 'completed').length;
      const hasVerification = allTasks.some(t =>
        /verif|review|test|check/i.test(t.title),
      );
      const nudge = completedCount >= 3 && !hasVerification;

      let response = `Task #${task.id} updated: status=${task.status}`;
      if (task.owner) response += `, owner=${task.owner}`;
      if (task.result) response += `\nResult: ${task.result}`;

      const remaining = allTasks.filter(t => t.status === 'pending').length;
      const inProgress = allTasks.filter(t => t.status === 'in_progress').length;
      response += `\n\nQueue: ${remaining} pending, ${inProgress} in progress, ${completedCount} completed.`;

      if (remaining > 0) {
        response += '\nCall SharedTaskList now to find your next available task.';
      } else if (inProgress === 0) {
        response += '\nAll tasks completed!';
      }

      if (nudge) {
        response += '\n\n💡 Verification recommended: 3+ tasks completed without a review/test task. Consider creating a verification task to validate the changes.';
      }

      // ── Auto-rollup: if this list is now fully complete, bubble up to parent ──
      const rollupMsg = await rollupIfComplete(params.taskListId);
      if (rollupMsg) {
        response += `\n\n${rollupMsg}`;
      }

      console.log(`[Pi:SharedTask] Updated #${task.id} → ${task.status} in "${params.taskListId}" (${completedCount}/${allTasks.length} done)`);

      return {
        content: [{ type: 'text' as const, text: response }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `SharedTaskUpdate error: ${err.message}` }],
        details: undefined,
      };
    }
  },
} as ToolDefinition;

// ═══════════════════════════════════════════════════════════════
// Tool 3: SharedTaskList — view all tasks, find next available
// ═══════════════════════════════════════════════════════════════

const ListParams = Type.Object({
  taskListId: Type.String({ description: 'The shared task list identifier' }),
  status: Type.Optional(Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
    Type.Literal('all'),
  ], { description: 'Filter by status. Default: all' })),
});

export const sharedTaskListTool: ToolDefinition = {
  name: 'SharedTaskList',
  label: 'Shared Task List',
  description:
    'View tasks in a shared queue. Shows status, owner, and priority. ' +
    'Use to find the next available (pending) task to work on.',
  promptSnippet: 'View shared task queue and find next available work.',
  promptGuidelines: [
    'Call SharedTaskList after completing a task to find the next one.',
    'Pick the lowest-ID pending task with the highest priority.',
    'If all tasks are completed or in_progress, report back to the coordinator.',
  ],
  parameters: ListParams,

  async execute(_toolCallId: string, params: {
    taskListId: string;
    status?: string;
  }) {
    try {
      const dir = getTaskDir(params.taskListId);
      let tasks = readAllTasks(dir);

      if (tasks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No tasks found in "${params.taskListId}". Use SharedTaskCreate to add tasks.` }],
          details: undefined,
        };
      }

      // Filter
      const filter = params.status || 'all';
      if (filter !== 'all') {
        tasks = tasks.filter(t => t.status === filter);
      }

      // Format output
      const lines = tasks.map(t => {
        const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳';
        const ownerStr = t.owner ? ` (${t.owner})` : '';
        const resultStr = t.result ? `\n     └─ ${t.result}` : '';
        const descStr = t.description ? `\n     └─ ${t.description}` : '';
        const subListStr = t.subtaskListId ? `\n     └─ 📋 Sub-list: "${t.subtaskListId}"` : '';
        return `  ${icon} #${t.id} [${t.priority}] ${t.title}${ownerStr}${subListStr}${resultStr}${descStr}`;
      });

      const allTasks = readAllTasks(dir);
      const pending = allTasks.filter(t => t.status === 'pending');
      const completed = allTasks.filter(t => t.status === 'completed').length;
      const total = allTasks.length;

      let response = `Shared TaskList "${params.taskListId}" (${completed}/${total} done):\n${lines.join('\n')}`;

      // Suggest next task
      if (pending.length > 0) {
        // Pick highest priority first, then lowest ID
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const next = [...pending].sort((a, b) =>
          (priorityOrder[a.priority] - priorityOrder[b.priority]) || (a.id - b.id),
        )[0];
        response += `\n\n→ Next suggested: #${next.id} [${next.priority}] "${next.title}"`;
        response += '\n  Claim it with: SharedTaskUpdate(id=${next.id}, status="in_progress", owner="your-name")';
      } else if (completed === total) {
        response += '\n\n✅ All tasks completed! Report results to the coordinator.';
      }

      return {
        content: [{ type: 'text' as const, text: response }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `SharedTaskList error: ${err.message}` }],
        details: undefined,
      };
    }
  },
} as ToolDefinition;
