import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'MyTodoView.tsx'), 'utf8');

describe('MyTodoView locale contract', () => {
  it('routes task errors, controls, counts, and dates through common locale keys', () => {
    for (const key of [
      'myTodo.error.loadWithStatus',
      'myTodo.error.addWithStatus',
      'myTodo.error.toggleWithStatus',
      'myTodo.remaining',
      'myTodo.placeholder',
      'myTodo.completed',
      'myTodo.created',
      'myTodo.completedAt',
    ]) expect(source).toContain(key);
  });

  it('preserves personal todo API boundaries and optimistic rollback', () => {
    expect(source).toContain("fetch('/api/personal-space/todos'");
    expect(source).toContain("fetch(`/api/personal-space/todos/${todo.id}`");
    expect(source).toContain('item.id === todo.id ? todo : item');
  });
});
