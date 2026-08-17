import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

function openPersonalMaterials() {
  window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path: 'personal://materials', split: 'right' } }));
}

/** Clickable user-owned My Todo list rendered inside the right Viewer Pane. */
export function PersonalTodoView() {
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
      if (!res.ok) throw new Error(data.error || '내 Todo를 불러오지 못했습니다');
      setTodos(Array.isArray(data.todos) ? data.todos : []);
    } catch (error) {
      toastError(error instanceof Error ? error.message : '내 Todo를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (!res.ok) throw new Error(data.error || '내 Todo를 추가하지 못했습니다');
      setTodos((current) => [data, ...current]);
      setNewTitle('');
    } catch (error) {
      toastError(error instanceof Error ? error.message : '내 Todo를 추가하지 못했습니다');
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
      if (!res.ok) throw new Error(data.error || '내 Todo 상태를 바꾸지 못했습니다');
      setTodos((current) => current.map((item) => item.id === todo.id ? data : item));
    } catch (error) {
      await load();
      toastError(error instanceof Error ? error.message : '내 Todo 상태를 바꾸지 못했습니다');
    }
  };

  const archiveTodo = async (todo: PersonalTodo) => {
    try {
      const res = await fetch(`/api/personal-space/todos/${todo.id}`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '내 Todo를 보관하지 못했습니다');
      setTodos((current) => current.filter((item) => item.id !== todo.id));
      toastSuccess('내 Todo를 보관했습니다');
    } catch (error) {
      toastError(error instanceof Error ? error.message : '내 Todo를 보관하지 못했습니다');
    }
  };

  const row = (todo: PersonalTodo) => (
    <div key={todo.id} className={`group flex items-start gap-3 rounded-xl border px-3 py-3 transition ${todo.completed ? 'border-surface-800 bg-surface-900/35' : 'border-surface-700 bg-surface-900/75 hover:border-surface-600'}`}>
      <button type="button" onClick={() => { void toggleTodo(todo); }} className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${todo.completed ? 'border-primary-500 bg-primary-500 text-white' : 'border-surface-600 bg-surface-950 hover:border-primary-400'}`} aria-label={todo.completed ? '완료 취소' : '완료 처리'}>
        {todo.completed && <span aria-hidden="true">✓</span>}
      </button>
      <div className="min-w-0 flex-1">
        <p className={`text-[14px] leading-6 ${todo.completed ? 'text-surface-500 line-through' : 'text-surface-100'}`}>{todo.title}</p>
        <p className="mt-1 text-[11px] text-surface-600">등록 {formatRegisteredAt(todo.createdAt)}{todo.completedAt ? ` · 완료 ${formatRegisteredAt(todo.completedAt)}` : ''}</p>
      </div>
      <button type="button" onClick={() => { void archiveTodo(todo); }} className="mt-0.5 hidden rounded-md px-2 py-1 text-[11px] text-surface-500 hover:bg-surface-800 hover:text-red-300 group-hover:block focus:block">보관</button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-950">
      <header className="shrink-0 border-b border-surface-800 px-5 py-4">
        <button type="button" onClick={openPersonalMaterials} className="mb-3 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100" aria-label="내 자료로 돌아가기">
          <span aria-hidden="true">←</span><span>내 자료</span>
        </button>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-primary-300">My Todo</p>
            <h2 className="mt-1 text-xl font-bold text-surface-100">내 Todo</h2>
          </div>
          <span className="rounded-full border border-surface-700 bg-surface-900 px-2.5 py-1 text-[12px] text-surface-400">남은 일 {openTodos.length}</span>
        </div>
        <div className="mt-4 flex gap-2">
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return; event.preventDefault(); void addTodo(event.currentTarget.value); }} placeholder="할 일을 입력하고 Enter" disabled={adding} className="h-10 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 text-sm text-surface-100 outline-none placeholder:text-surface-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 disabled:opacity-60" />
          <button type="button" onClick={() => { void addTodo(); }} disabled={adding || !newTitle.trim()} className="rounded-lg bg-primary-500 px-3 text-sm font-semibold text-white hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-50">{adding ? '추가 중…' : '추가'}</button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? <p className="py-12 text-center text-sm text-surface-500">내 Todo를 불러오는 중…</p> : (
          <>
            <div className="space-y-2">{openTodos.map(row)}</div>
            {openTodos.length === 0 && <p className="rounded-xl border border-dashed border-surface-700 py-10 text-center text-sm text-surface-500">남은 할 일이 없습니다.</p>}
            {completedTodos.length > 0 && (
              <section className="mt-6 border-t border-surface-800 pt-4">
                <button type="button" onClick={() => setShowCompleted((value) => !value)} className="flex w-full items-center justify-between text-left text-[13px] font-semibold text-surface-400 hover:text-surface-200">
                  <span>완료됨 {completedTodos.length}</span><span>{showCompleted ? '접기' : '펼치기'}</span>
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
