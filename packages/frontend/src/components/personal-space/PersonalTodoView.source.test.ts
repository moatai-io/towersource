import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PersonalTodoView.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('PersonalTodoView', () => {
  it('renders a localized clickable My Todo list with registration dates', () => {
    expect(source).toContain("useTranslation('layout')");
    expect(source).toContain("t('personalTodo.title')");
    expect(source).toContain("t('personalTodo.markComplete')");
    expect(source).toContain("t('personalTodo.markIncomplete')");
    expect(source).toContain("t('personalTodo.registeredAt', { date: formatRegisteredAt(todo.createdAt) })");
    expect(source).toContain('i18n.resolvedLanguage || i18n.language');
  });

  it('returns to My Materials even when the temporary Viewer tab was replaced', () => {
    expect(source).toContain("path: 'personal://materials'");
    expect(source).toContain("split: 'right'");
    expect(source).toContain("aria-label={t('backToMyMaterials')}");
    expect(app).toContain("if (path === 'personal://materials' || path === 'personal://documents')");
    expect(app).toContain('openPersonalMaterialsInViewer();');
  });

  it('strikes completed items and puts them in a separate completed section', () => {
    expect(source).toContain("'text-surface-500 line-through'");
    expect(source).toContain("t('personalTodo.completedCount', { count: completedTodos.length })");
    expect(source).toContain('completedTodos.map(row)');
  });

  it('supports direct add, toggle, and archive actions', () => {
    expect(source).toContain("fetch('/api/personal-space/todos'");
    expect(source).toContain("method: 'PATCH'");
    expect(source).toContain("method: 'DELETE'");
  });

  it('creates only once for Enter during Korean IME composition or rapid repeats', () => {
    expect(source).toContain('event.nativeEvent.isComposing');
    expect(source).toContain('event.keyCode === 229');
    expect(source).toContain('event.preventDefault()');
    expect(source).toContain('addTodo(event.currentTarget.value)');
    expect(source).toContain('if (!title || addingRef.current) return');
    expect(source).toContain('addingRef.current = true');
    expect(source).toContain('disabled={adding || !newTitle.trim()}');
  });
});
