/**
 * Owns: 사용자별 구조화된 `내 할 일 · My Todo` 저장과 owner ACL.
 * Public API: listPersonalTodos, createPersonalTodo, updatePersonalTodo, archivePersonalTodo.
 * See README.md.
 */
import { execute, query, queryOne } from '../../db/pg-repo.js';
import { PersonalSpaceError } from './personal-space-store.js';

export interface PersonalTodo {
  id: string;
  title: string;
  note: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PersonalTodoRow {
  id: string;
  title: string;
  note: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function validateUserId(userId: number): void {
  if (!Number.isInteger(userId) || userId <= 0) throw new PersonalSpaceError('INVALID_PATH', 'Invalid user');
}

function normalizeTitle(title: string): string {
  const value = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
  if (!value) throw new PersonalSpaceError('INVALID_PATH', '내 할 일 제목이 필요합니다');
  if (value.length > 500) throw new PersonalSpaceError('TOO_LARGE', '내 할 일 제목은 500자 이하여야 합니다');
  return value;
}

function toTodo(row: PersonalTodoRow): PersonalTodo {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    completed: row.completed_at != null,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List active items with incomplete first and completed items below. */
export async function listPersonalTodos(userId: number): Promise<PersonalTodo[]> {
  validateUserId(userId);
  const rows = await query<PersonalTodoRow>(
    `SELECT id, title, note, completed_at, created_at, updated_at
       FROM personal_todos
      WHERE owner_user_id = $1 AND archived_at IS NULL
      ORDER BY (completed_at IS NOT NULL),
               CASE WHEN completed_at IS NULL THEN sort_order END ASC,
               CASE WHEN completed_at IS NULL THEN created_at END DESC,
               completed_at DESC NULLS LAST`,
    [userId],
  );
  return rows.map(toTodo);
}

/** Add one owner-scoped My Todo item. */
export async function createPersonalTodo(userId: number, title: string, sourceSessionId?: string): Promise<PersonalTodo> {
  validateUserId(userId);
  const row = await queryOne<PersonalTodoRow>(
    `INSERT INTO personal_todos (owner_user_id, title, source_session_id, sort_order)
     VALUES ($1, $2, $3, COALESCE((SELECT MIN(sort_order) - 1 FROM personal_todos WHERE owner_user_id = $1 AND archived_at IS NULL), 0))
     RETURNING id, title, note, completed_at, created_at, updated_at`,
    [userId, normalizeTitle(title), sourceSessionId || null],
  );
  if (!row) throw new Error('내 할 일을 추가하지 못했습니다');
  return toTodo(row);
}

/** Update title or completion state after proving ownership in the SQL predicate. */
export async function updatePersonalTodo(userId: number, id: string, patch: { title?: string; completed?: boolean }): Promise<PersonalTodo> {
  validateUserId(userId);
  const hasTitle = patch.title !== undefined;
  const hasCompleted = patch.completed !== undefined;
  if (!hasTitle && !hasCompleted) throw new PersonalSpaceError('INVALID_PATH', '변경할 내용이 필요합니다');
  const row = await queryOne<PersonalTodoRow>(
    `UPDATE personal_todos
        SET title = CASE WHEN $3 THEN $4 ELSE title END,
            completed_at = CASE WHEN $5 THEN CASE WHEN $6 THEN COALESCE(completed_at, NOW()) ELSE NULL END ELSE completed_at END,
            updated_at = NOW()
      WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL
      RETURNING id, title, note, completed_at, created_at, updated_at`,
    [id, userId, hasTitle, hasTitle ? normalizeTitle(patch.title!) : '', hasCompleted, patch.completed === true],
  );
  if (!row) throw new PersonalSpaceError('NOT_FOUND', '내 할 일을 찾지 못했습니다');
  return toTodo(row);
}

/** Soft-archive one owner-scoped item. */
export async function archivePersonalTodo(userId: number, id: string): Promise<void> {
  validateUserId(userId);
  const result = await execute(
    `UPDATE personal_todos SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL`,
    [id, userId],
  );
  if (!result.changes) throw new PersonalSpaceError('NOT_FOUND', '내 할 일을 찾지 못했습니다');
}
