import { query, queryOne, execute } from '../db/pg-repo.js';

export async function listSpaces() {
  return query('SELECT * FROM spaces WHERE archived = 0 ORDER BY sort_order, name');
}

export async function getSpace(id: number) {
  return queryOne('SELECT * FROM spaces WHERE id = $1', [id]);
}

export async function createSpace(name: string, opts: {
  slug?: string;
  description?: string;
  type?: string;
  color?: string;
  icon?: string;
}) {
  const slug = opts.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await queryOne(`
    INSERT INTO spaces (name, slug, description, type, color, icon, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT MAX(sort_order) + 1 FROM spaces), 0))
    RETURNING *
  `, [name, slug, opts.description || null, opts.type || 'custom',
      opts.color || '#6b7280', opts.icon || 'folder']);
  return result;
}

export async function updateSpace(id: number, updates: Partial<{
  name: string; description: string; color: string; icon: string;
  sortOrder: number; archived: number;
}>) {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  }
  if (sets.length === 0) return getSpace(id);
  vals.push(id);
  await execute(`UPDATE spaces SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return queryOne('SELECT * FROM spaces WHERE id = $1', [id]);
}

export async function deleteSpace(id: number) {
  // 하위 프로젝트는 미분류로
  await execute('UPDATE projects SET space_id = NULL WHERE space_id = $1', [id]);
  await execute('DELETE FROM spaces WHERE id = $1', [id]);
}

export async function moveProjectToSpace(projectId: string, spaceId: number | null) {
  await execute('UPDATE projects SET space_id = $1 WHERE id = $2', [spaceId, projectId]);
}
