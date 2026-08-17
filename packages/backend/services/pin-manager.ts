import { query, queryOne, execute, transaction, withClient } from '../db/pg-repo.js';
import { loadCommands } from './skill/command-loader.js';
import { getCommandsForUser, hasProjectManagedSkillManifestForContext } from './skill/skill-registry.js';

export type { PromptItem } from '@tower/shared';
import type { Pin as PinBase, PromptItem } from '@tower/shared';

export interface Pin extends PinBase {
  pin_type: 'file' | 'prompt';
  content: string | null;
  user_id: number | null;
}

export async function getPins(userId?: number): Promise<Pin[]> {
  if (userId) {
    return await query<Pin>(
      `SELECT * FROM pins WHERE user_id = $1 ORDER BY sort_order ASC, created_at DESC`,
      [userId]
    );
  }
  return await query<Pin>(
    `SELECT * FROM pins ORDER BY sort_order ASC, created_at DESC`
  );
}

export async function createPin(title: string, filePath: string, fileType: string, userId?: number): Promise<Pin> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO pins (title, file_path, file_type, user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, filePath, fileType, userId || null]
  );
  return {
    id: row!.id,
    title,
    file_path: filePath,
    file_type: fileType,
    pin_type: 'file',
    content: null,
    sort_order: 0,
    user_id: userId || null,
    created_at: new Date().toISOString(),
  };
}

export async function updatePin(id: number, updates: { title?: string; sortOrder?: number }, userId?: number): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (updates.title !== undefined) { sets.push(`title = $${idx++}`); vals.push(updates.title); }
  if (updates.sortOrder !== undefined) { sets.push(`sort_order = $${idx++}`); vals.push(updates.sortOrder); }
  if (sets.length === 0) return;
  vals.push(id);
  let where = `WHERE id = $${idx++}`;
  if (userId) { where += ` AND user_id = $${idx++}`; vals.push(userId); }
  await execute(`UPDATE pins SET ${sets.join(', ')} ${where}`, vals);
}

export async function deletePin(id: number, userId?: number): Promise<void> {
  if (userId) {
    await execute(`DELETE FROM pins WHERE id = $1 AND user_id = $2`, [id, userId]);
  } else {
    await execute(`DELETE FROM pins WHERE id = $1`, [id]);
  }
}

export async function reorderPins(orderedIds: number[], userId?: number): Promise<void> {
  await transaction(async (client) => {
    const db = withClient(client);
    for (let index = 0; index < orderedIds.length; index++) {
      if (userId) {
        await db.execute(`UPDATE pins SET sort_order = $1 WHERE id = $2 AND user_id = $3`, [index, orderedIds[index], userId]);
      } else {
        await db.execute(`UPDATE pins SET sort_order = $1 WHERE id = $2`, [index, orderedIds[index]]);
      }
    }
  });
}

// ───── Prompt CRUD ─────

export async function createPromptPin(title: string, content: string, userId?: number): Promise<Pin> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO pins (title, file_path, file_type, pin_type, content, user_id) VALUES ($1, '', 'text', 'prompt', $2, $3) RETURNING id`,
    [title, content, userId || null]
  );
  return {
    id: row!.id,
    title,
    file_path: '',
    file_type: 'text',
    pin_type: 'prompt',
    content,
    sort_order: 0,
    user_id: userId || null,
    created_at: new Date().toISOString(),
  };
}

export async function updatePromptPin(id: number, updates: { title?: string; content?: string }, userId?: number): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (updates.title !== undefined) { sets.push(`title = $${idx++}`); vals.push(updates.title); }
  if (updates.content !== undefined) { sets.push(`content = $${idx++}`); vals.push(updates.content); }
  if (sets.length === 0) return;
  vals.push(id);
  let where = `WHERE id = $${idx++} AND pin_type = 'prompt'`;
  if (userId) { where += ` AND user_id = $${idx++}`; vals.push(userId); }
  await execute(`UPDATE pins SET ${sets.join(', ')} ${where}`, vals);
}

export async function getPromptsWithCommands(userId?: number, username?: string | null, projectId?: string | null, cwd?: string): Promise<PromptItem[]> {
  const prompts: PromptItem[] = [];

  // DB prompts
  const rows = userId
    ? await query<Pin>(`SELECT * FROM pins WHERE pin_type = 'prompt' AND user_id = $1 ORDER BY sort_order ASC, created_at DESC`, [userId])
    : await query<Pin>(`SELECT * FROM pins WHERE pin_type = 'prompt' ORDER BY sort_order ASC, created_at DESC`);

  for (const row of rows) {
    prompts.push({
      id: row.id,
      title: row.title,
      content: row.content || '',
      source: 'user',
      readonly: false,
    });
  }

  // Merge slash-command prompts. Prefer the Tower skill registry / project-local
  // skill paths; keep the old filesystem command scan only as a compatibility
  // fallback while legacy command users are migrated. If the project has a
  // managed `.tower/skills/manifest.json`, even an empty registry result is
  // authoritative and must not fall back to host-global `~/.claude` commands.
  let commands: Array<{ name: string; fullContent: string }> = await getCommandsForUser(userId, projectId ?? null, username ?? null, cwd);
  const projectManifestAuthoritative = await hasProjectManagedSkillManifestForContext(projectId ?? null, cwd);
  if (commands.length === 0 && !projectManifestAuthoritative) {
    commands = loadCommands();
  }
  for (const cmd of commands) {
    prompts.push({
      id: `cmd:${cmd.name}`,
      title: cmd.name,
      content: cmd.fullContent,
      source: 'commands',
      readonly: true,
    });
  }

  return prompts;
}
