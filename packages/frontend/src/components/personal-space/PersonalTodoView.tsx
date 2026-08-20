import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { toastError, toastSuccess } from '../../utils/toast';

interface PersonalTodo {
  id: string;
  title: string;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function formatRegisteredAt(value: string): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

function openPersonalMaterials() {
  window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path: 'personal://materials', split: 'right' } }));
}

/** Clickable user-owned My Todo list rendered inside the right Viewer Pane. */
export function PersonalTodoView() {
  const { t } = useTranslation('layout');
  const [todos, setTodos] = useState<PersonalTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/personal-space/todos', { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalTodo.loadFailed'));
      setTodos(Array.isArray(data.todos) ? data.todos : []);
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('personalTodo.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const openTodos = useMemo(() => todos.filter((todo) => !todo.completed), [todos]);
  const completedTodos = useMemo(() => todos.filter((todo) => todo.completed), [todos]);

  const addTodo = async (immediateTitle?: string) => {
    const title = (typeof immediateTitle === 'string' ? immediateTitle : newTitle).trim();
    if (!title || addingRef.current) return;
    // React state alone is not synchronous enough to stop two Enter events from
    // Korean IME composition. Lock before starting the request.
    addingRef.current = true;
    setAdding(true);
    try {
      const res = await fetch('/api/personal-space/todos', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ title }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalTodo.addFailed'));
      setTodos((current) => [data, ...current]);
      setNewTitle('');
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('personalTodo.addFailed'));
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const toggleTodo = async (todo: PersonalTodo) => {
    const completed = !todo.completed;
    setTodos((current) => current.map((item) => item.id === todo.id ? { ...item, completed, completedAt: completed ? new Date().toISOString() : null } : item));
    try {
      const res = await fetch(`/api/personal-space/todos/${todo.id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ completed }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalTodo.updateFailed'));
      setTodos((current) => current.map((item) => item.id === todo.id ? data : item));
    } catch (error) {
      await load();
      toastError(error instanceof Error ? error.message : t('personalTodo.updateFailed'));
    }
  };

  const archiveTodo = async (todo: PersonalTodo) => {
    try {
      const res = await fetch(`/api/personal-space/todos/${todo.id}`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalTodo.archiveFailed'));
      setTodos((current) => current.filter((item) => item.id !== todo.id));
      toastSuccess(t('personalTodo.archived'));
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('personalTodo.archiveFailed'));
    }
  };

  const row = (todo: PersonalTodo) => (
    <div key={todo.id} className={`group flex items-start gap-3 rounded-xl border px-3 py-3 transition ${todo.completed ? 'border-surface-800 bg-surface-900/35' : 'border-surface-700 bg-surface-900/75 hover:border-surface-600'}`}>
      <button type="button" onClick={() => { void toggleTodo(todo); }} className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${todo.completed ? 'border-primary-500 bg-primary-500 text-white' : 'border-surface-600 bg-surface-950 hover:border-primary-400'}`} aria-label={todo.completed ? t('personalTodo.markIncomplete') : t('personalTodo.markComplete')}>
        {todo.completed && <span aria-hidden="true">✓</span>}
      </button>
      <div className="min-w-0 flex-1">
        <p className={`text-[14px] leading-6 ${todo.completed ? 'text-surface-500 line-through' : 'text-surface-100'}`}>{todo.title}</p>
        <p className="mt-1 text-[11px] text-surface-600">{t('personalTodo.registeredAt', { date: formatRegisteredAt(todo.createdAt) })}{todo.completedAt ? t('personalTodo.completedAt', { date: formatRegisteredAt(todo.completedAt) }) : ''}</p>
      </div>
      <button type="button" onClick={() => { void archiveTodo(todo); }} className="mt-0.5 hidden rounded-md px-2 py-1 text-[11px] text-surface-500 hover:bg-surface-800 hover:text-red-300 group-hover:block focus:block">{t('personalTodo.archive')}</button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-950">
      <header className="shrink-0 border-b border-surface-800 px-5 py-4">
        <button type="button" onClick={openPersonalMaterials} className="mb-3 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100" aria-label={t('backToMyMaterials')}>
          <span aria-hidden="true">←</span><span>{t('myMaterials')}</span>
        </button>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-primary-300">My Todo</p>
            <h2 className="mt-1 text-xl font-bold text-surface-100">{t('personalTodo.title')}</h2>
          </div>
          <span className="rounded-full border border-surface-700 bg-surface-900 px-2.5 py-1 text-[12px] text-surface-400">{t('personalTodo.openCount', { count: openTodos.length })}</span>
        </div>
        <div className="mt-4 flex gap-2">
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return; event.preventDefault(); void addTodo(event.currentTarget.value); }} placeholder={t('personalTodo.placeholder')} disabled={adding} className="h-10 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 text-sm text-surface-100 outline-none placeholder:text-surface-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 disabled:opacity-60" />
          <button type="button" onClick={() => { void addTodo(); }} disabled={adding || !newTitle.trim()} className="rounded-lg bg-primary-500 px-3 text-sm font-semibold text-white hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-50">{adding ? t('personalTodo.adding') : t('personalTodo.add')}</button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? <p className="py-12 text-center text-sm text-surface-500">{t('personalTodo.loading')}</p> : (
          <>
            <div className="space-y-2">{openTodos.map(row)}</div>
            {openTodos.length === 0 && <p className="rounded-xl border border-dashed border-surface-700 py-10 text-center text-sm text-surface-500">{t('personalTodo.empty')}</p>}
            {completedTodos.length > 0 && (
              <section className="mt-6 border-t border-surface-800 pt-4">
                <button type="button" onClick={() => setShowCompleted((value) => !value)} className="flex w-full items-center justify-between text-left text-[13px] font-semibold text-surface-400 hover:text-surface-200">
                  <span>{t('personalTodo.completedCount', { count: completedTodos.length })}</span><span>{showCompleted ? t('personalTodo.collapse') : t('personalTodo.expand')}</span>
                </button>
                {showCompleted && <div className="mt-3 space-y-2">{completedTodos.map(row)}</div>}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
