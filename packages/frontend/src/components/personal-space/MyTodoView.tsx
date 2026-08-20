import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { toastError } from '../../utils/toast';

interface PersonalTodo {
  id: string;
  title: string;
  note: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Interactive user-owned My Todo list rendered inside the Viewer Pane. */
export function MyTodoView() {
  const { t } = useTranslation('common');
  const [todos, setTodos] = useState<PersonalTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/personal-space/todos', { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('myTodo.error.loadWithStatus', { status: res.status }));
      setTodos(Array.isArray(data.todos) ? data.todos : []);
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('myTodo.error.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const openItems = useMemo(() => todos.filter((todo) => !todo.completed), [todos]);
  const completedItems = useMemo(() => todos.filter((todo) => todo.completed), [todos]);

  const addTodo = async () => {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      const res = await fetch('/api/personal-space/todos', {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ title }),
      });
      const todo = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(todo.error || t('myTodo.error.addWithStatus', { status: res.status }));
      setTodos((current) => [todo, ...current]);
      setNewTitle('');
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('myTodo.error.add'));
    } finally {
      setAdding(false);
    }
  };

  const toggleTodo = async (todo: PersonalTodo) => {
    const completed = !todo.completed;
    setTodos((current) => current.map((item) => item.id === todo.id ? { ...item, completed, completedAt: completed ? new Date().toISOString() : null } : item));
    try {
      const res = await fetch(`/api/personal-space/todos/${todo.id}`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ completed }),
      });
      const updated = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(updated.error || t('myTodo.error.toggleWithStatus', { status: res.status }));
      setTodos((current) => current.map((item) => item.id === todo.id ? updated : item));
    } catch (error) {
      setTodos((current) => current.map((item) => item.id === todo.id ? todo : item));
      toastError(error instanceof Error ? error.message : t('myTodo.error.toggle'));
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-950 px-5 py-5 text-surface-100">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-300">{t('myTodo.eyebrow')}</div>
            <h1 className="mt-1 text-xl font-bold">{t('myTodo.title')}</h1>
            <p className="mt-1 text-[13px] text-surface-500">{t('myTodo.description')}</p>
          </div>
          <span className="rounded-full border border-surface-700 bg-surface-900 px-2.5 py-1 text-[12px] text-surface-400">{t('myTodo.remaining', { count: openItems.length })}</span>
        </div>

        <div className="mt-5 flex gap-2">
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addTodo(); }}
            placeholder={t('myTodo.placeholder')}
            className="h-10 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 text-sm outline-none placeholder:text-surface-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
          />
          <button type="button" onClick={() => { void addTodo(); }} disabled={!newTitle.trim() || adding} className="h-10 rounded-lg bg-primary-500 px-4 text-sm font-semibold text-white hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-40">{t('myTodo.add')}</button>
        </div>

        <div className="mt-5 space-y-1">
          {loading ? (
            <div className="py-12 text-center text-sm text-surface-500">{t('myTodo.loading')}</div>
          ) : openItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-surface-700 px-4 py-10 text-center text-sm text-surface-500">{t('myTodo.empty')}</div>
          ) : openItems.map((todo) => (
            <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} t={t} />
          ))}
        </div>

        {completedItems.length > 0 && (
          <details className="mt-7" open>
            <summary className="cursor-pointer select-none text-[13px] font-semibold text-surface-500 hover:text-surface-300">{t('myTodo.completed', { count: completedItems.length })}</summary>
            <div className="mt-2 space-y-1 border-t border-surface-800 pt-2">
              {completedItems.map((todo) => <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} t={t} />)}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function TodoRow({ todo, onToggle, t }: { todo: PersonalTodo; onToggle: (todo: PersonalTodo) => Promise<void>; t: (key: string, options?: Record<string, unknown>) => string }) {
  return (
    <label className={`group flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition hover:bg-surface-900 ${todo.completed ? 'opacity-65' : ''}`}>
      <input type="checkbox" checked={todo.completed} onChange={() => { void onToggle(todo); }} className="mt-0.5 h-4 w-4 shrink-0 accent-primary-500" />
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] leading-5 ${todo.completed ? 'text-surface-500 line-through' : 'text-surface-200'}`}>{todo.title}</span>
        <span className="mt-1 block text-[11px] text-surface-600">{t('myTodo.created', { date: formatDate(todo.createdAt) })}{todo.completedAt ? ` · ${t('myTodo.completedAt', { date: formatDate(todo.completedAt) })}` : ''}</span>
      </span>
    </label>
  );
}
