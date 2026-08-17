import React from 'react';
import type { WorkspaceAppMenuItem } from './workspace-app-definition';

export function WorkspaceAppSidebar({
  title,
  items,
  activeId,
  onSelect,
}: {
  title: string;
  items: WorkspaceAppMenuItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
      <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-surface-500">{title}</div>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={`mb-1 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-[13px] font-semibold transition ${active
              ? 'border-blue-300 bg-blue-50 text-blue-900 dark:border-primary-500/40 dark:bg-primary-500/15 dark:text-primary-100'
              : 'border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-950 dark:text-surface-400 dark:hover:border-surface-800 dark:hover:bg-surface-850/70 dark:hover:text-surface-100'}`}
          >
            <span>{item.label}</span>
            {item.live && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200">연결됨</span>}
          </button>
        );
      })}
    </aside>
  );
}
