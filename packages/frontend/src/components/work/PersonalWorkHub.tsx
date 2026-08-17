import React from 'react';

interface PersonalItem {
  id: string;
  uri: string;
  name: string;
  kind: 'note' | 'file';
  updatedAt: string;
}

interface PersonalTodo {
  id: string;
  completed: boolean;
}

interface PersonalWorkHubProps {
  onOpenTodos: () => void;
  onOpenItem: (uri: string) => void;
  onCreateNote: () => void;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

/** Personal notes and checklist entry points. Todos remain a note-like personal view. */
export function PersonalWorkHub({ onOpenTodos, onOpenItem, onCreateNote }: PersonalWorkHubProps) {
  const [items, setItems] = React.useState<PersonalItem[]>([]);
  const [openTodoCount, setOpenTodoCount] = React.useState(0);
  const [itemsLoading, setItemsLoading] = React.useState(true);
  const [todosLoading, setTodosLoading] = React.useState(true);
  const [itemsFailed, setItemsFailed] = React.useState(false);
  const [todosFailed, setTodosFailed] = React.useState(false);
  const [loadAttempt, setLoadAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setItemsLoading(true);
    setTodosLoading(true);
    setItemsFailed(false);
    setTodosFailed(false);

    const readPersonalJson = async (url: string) => {
      const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
      if (!res.ok) throw new Error(`personal-space request failed: ${res.status}`);
      return res.json();
    };

    // Settle each card independently. A slow file index must not keep Todo or
    // approvals in a global loading state on mobile connections.
    void readPersonalJson('/api/personal-space/files')
      .then((fileData) => {
        if (!active) return;
        const nextItems = Array.isArray(fileData.files) ? fileData.files as PersonalItem[] : [];
        setItems(nextItems.slice(0, 5));
      })
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        setItemsFailed(true);
        console.warn('[my-work] personal files load failed:', error);
      })
      .finally(() => { if (active) setItemsLoading(false); });

    void readPersonalJson('/api/personal-space/todos')
      .then((todoData) => {
        if (!active) return;
        const todos = Array.isArray(todoData.todos) ? todoData.todos as PersonalTodo[] : [];
        setOpenTodoCount(todos.filter((todo) => !todo.completed).length);
      })
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        setTodosFailed(true);
        console.warn('[my-work] personal todos load failed:', error);
      })
      .finally(() => { if (active) setTodosLoading(false); });

    return () => {
      active = false;
      controller.abort();
    };
  }, [loadAttempt]);

  return (
    <section aria-labelledby="personal-materials-title" className="mt-5 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/45">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-surface-800 px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300/80">Personal notes</div>
          <h2 id="personal-materials-title" className="mt-0.5 text-[17px] font-semibold text-surface-100">내 자료</h2>
          <p className="mt-1 text-[12px] leading-5 text-surface-500">나만 볼 수 있는 노트와 체크리스트입니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onOpenTodos} className="rounded-md border border-surface-700 px-3 py-2 text-[12px] font-semibold text-surface-200 hover:border-primary-500/50 hover:text-primary-300">
            체크리스트 {todosLoading ? '' : todosFailed ? '· 확인 필요' : `· ${openTodoCount}`}
          </button>
          <button type="button" onClick={onCreateNote} className="rounded-md bg-primary-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-primary-400">+ 새 노트</button>
        </div>
      </div>

      {(itemsFailed || todosFailed) && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-[12px] text-amber-100">
          <span>일부 개인 자료를 불러오지 못했습니다.</span>
          <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="shrink-0 rounded-md border border-amber-300/30 px-2.5 py-1 font-semibold hover:bg-amber-300/10">다시 시도</button>
        </div>
      )}

      <div className="px-4 py-2">
        {itemsLoading ? <p className="py-3 text-[12px] text-surface-500">불러오는 중…</p> : itemsFailed ? <p className="py-3 text-[12px] leading-5 text-amber-300">자료 목록을 불러오지 못했습니다.</p> : items.length === 0 ? <p className="py-3 text-[12px] leading-5 text-surface-500">아직 개인 자료가 없습니다. 첫 노트를 만들어보세요.</p> : (
          <div className="divide-y divide-surface-800">
            {items.map((item) => <button key={item.id} type="button" onClick={() => onOpenItem(item.uri)} className="flex w-full items-center gap-2 py-2 text-left hover:text-primary-300"><span aria-hidden="true">{item.kind === 'note' ? '📝' : '📎'}</span><span className="min-w-0 flex-1 truncate text-[12px] text-surface-300">{item.name}</span><span className="shrink-0 text-[10px] text-surface-600">{formatDate(item.updatedAt)}</span></button>)}
          </div>
        )}
      </div>
    </section>
  );
}
