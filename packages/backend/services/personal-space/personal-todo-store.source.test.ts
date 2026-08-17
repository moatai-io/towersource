import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../db/migrations/108_personal_todos.sql', import.meta.url), 'utf8');
const store = readFileSync(new URL('./personal-todo-store.ts', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../routes/personal-space-api.ts', import.meta.url), 'utf8');

describe('structured Personal Space My Todo contract', () => {
  it('stores owner-scoped structured items independently from markdown notes', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS personal_todos');
    expect(migration).toContain('owner_user_id');
    expect(migration).toContain('completed_at');
    expect(migration).toContain('source_session_id TEXT REFERENCES sessions(id)');
    expect(migration).not.toContain('source_session_id UUID REFERENCES sessions(id)');
    expect(store).toContain('WHERE owner_user_id = $1');
    expect(store).toContain('WHERE id = $1 AND owner_user_id = $2');
  });

  it('exposes list, add, toggle/update, and archive endpoints', () => {
    expect(routes).toContain("router.get('/todos'");
    expect(routes).toContain("router.post('/todos'");
    expect(routes).toContain("router.patch('/todos/:id'");
    expect(routes).toContain("router.delete('/todos/:id'");
  });

  it('sorts incomplete items before completed items', () => {
    expect(store).toContain('ORDER BY (completed_at IS NOT NULL)');
  });
});
