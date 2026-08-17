import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
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
  const [todos, setTodos] = useState<PersonalTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/personal-space/todos', { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `내 할 일을 불러오지 못했습니다 (${res.status})`);
      setTodos(Array.isArray(data.todos) ? data.todos : []);
    } catch (error) {
      toastError(error instanceof Error ? error.message : '내 할 일을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (!res.ok) throw new Error(todo.error || `내 할 일을 추가하지 못했습니다 (${res.status})`);
      setTodos((current) => [todo, ...current]);
      setNewTitle('');
    } catch (error) {
      toastError(error instanceof Error ? error.message : '내 할 일을 추가하지 못했습니다');
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
      if (!res.ok) throw new Error(updated.error || `상태를 바꾸지 못했습니다 (${res.status})`);
      setTodos((current) => current.map((item) => item.id === todo.id ? updated : item));
    } catch (error) {
      setTodos((current) => current.map((item) => item.id === todo.id ? todo : item));
      toastError(error instanceof Error ? error.message : '상태를 바꾸지 못했습니다');
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-950 px-5 py-5 text-surface-100">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-300">My Todo</div>
            <h1 className="mt-1 text-xl font-bold">내 할 일</h1>
            <p className="mt-1 text-[13px] text-surface-500">체크하면 완료 항목으로 내려갑니다.</p>
          </div>
          <span className="rounded-full border border-surface-700 bg-surface-900 px-2.5 py-1 text-[12px] text-surface-400">남은 일 {openItems.length}</span>
        </div>

        <div className="mt-5 flex gap-2">
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addTodo(); }}
            placeholder="새 할 일을 입력하세요"
            className="h-10 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 text-sm outline-none placeholder:text-surface-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
          />
          <button type="button" onClick={() => { void addTodo(); }} disabled={!newTitle.trim() || adding} className="h-10 rounded-lg bg-primary-500 px-4 text-sm font-semibold text-white hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-40">추가</button>
        </div>

        <div className="mt-5 space-y-1">
          {loading ? (
            <div className="py-12 text-center text-sm text-surface-500">내 할 일을 불러오는 중…</div>
          ) : openItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-surface-700 px-4 py-10 text-center text-sm text-surface-500">남은 할 일이 없습니다.</div>
          ) : openItems.map((todo) => (
            <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} />
          ))}
        </div>

        {completedItems.length > 0 && (
          <details className="mt-7" open>
            <summary className="cursor-pointer select-none text-[13px] font-semibold text-surface-500 hover:text-surface-300">완료됨 {completedItems.length}개</summary>
            <div className="mt-2 space-y-1 border-t border-surface-800 pt-2">
              {completedItems.map((todo) => <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} />)}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function TodoRow({ todo, onToggle }: { todo: PersonalTodo; onToggle: (todo: PersonalTodo) => Promise<void> }) {
  return (
    <label className={`group flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition hover:bg-surface-900 ${todo.completed ? 'opacity-65' : ''}`}>
      <input type="checkbox" checked={todo.completed} onChange={() => { void onToggle(todo); }} className="mt-0.5 h-4 w-4 shrink-0 accent-primary-500" />
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] leading-5 ${todo.completed ? 'text-surface-500 line-through' : 'text-surface-200'}`}>{todo.title}</span>
        <span className="mt-1 block text-[11px] text-surface-600">등록 {formatDate(todo.createdAt)}{todo.completedAt ? ` · 완료 ${formatDate(todo.completedAt)}` : ''}</span>
      </span>
    </label>
  );
}
