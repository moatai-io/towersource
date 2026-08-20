import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceAppTableColumn, WorkspaceAppTableView as WorkspaceAppTableViewDefinition } from './workspace-app-definition';

function renderCell(column: WorkspaceAppTableColumn, value: string) {
  if (column.kind === 'status') {
    return <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[12px] font-semibold text-slate-700 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-300">{value}</span>;
  }
  const className = column.kind === 'money'
    ? 'text-right font-semibold tabular-nums text-slate-900 dark:text-surface-100'
    : column.key === 'name' ? 'font-semibold text-slate-950 dark:text-surface-100' : 'text-slate-700 dark:text-surface-300';
  return <span className={className}>{value}</span>;
}

export function WorkspaceAppTableView({
  view,
  activeSectionLabel,
  selectedRowIndex,
  onSelectRow,
}: {
  view: WorkspaceAppTableViewDefinition;
  activeSectionLabel?: string;
  selectedRowIndex?: number | null;
  onSelectRow?: (row: Record<string, string>, rowIndex: number) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <main className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-surface-800 dark:bg-surface-850/70">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-surface-500">{activeSectionLabel || t('workspaceApps.table.workList')}</div>
            <h2 className="mt-0.5 text-[17px] font-bold text-slate-950 dark:text-surface-50">{view.title}</h2>
            <p className="mt-1 text-[13px] text-slate-500 dark:text-surface-500">{view.subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">{view.statusLabel}</span>
            <button type="button" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-semibold text-slate-600 hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300 dark:hover:bg-surface-850">{t('workspaceApps.table.filter')}</button>
            <button type="button" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-semibold text-slate-600 hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300 dark:hover:bg-surface-850">{t('workspaceApps.table.export')}</button>
          </div>
        </div>
      </div>

      <div className="overflow-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-100 text-[11px] uppercase tracking-[0.06em] text-slate-500 dark:border-surface-800 dark:bg-surface-850 dark:text-surface-500">
            <tr>
              {view.columns.map((column) => (
                <th key={column.key} className={`border-r border-slate-200 px-3 py-2 font-bold last:border-r-0 dark:border-surface-800 ${column.kind === 'money' ? 'text-right' : ''}`}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-surface-800">
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={view.columns.length} className="px-4 py-10 text-center text-[13px] text-slate-500 dark:text-surface-500">
                  {t('workspaceApps.table.empty')}
                </td>
              </tr>
            ) : view.rows.map((row, rowIndex) => {
              const selected = selectedRowIndex === rowIndex;
              return (
                <tr
                  key={`${view.id}-${rowIndex}`}
                  onClick={() => onSelectRow?.(row, rowIndex)}
                  className={`cursor-pointer transition ${selected ? 'bg-blue-100/80 ring-1 ring-inset ring-blue-300 dark:bg-primary-500/10 dark:ring-primary-500/25' : 'hover:bg-blue-50/60 dark:hover:bg-primary-500/5'}`}
                >
                  {view.columns.map((column) => (
                    <td key={column.key} className={`border-r border-slate-100 px-3 py-2 last:border-r-0 dark:border-surface-800 ${column.kind === 'money' ? 'text-right' : ''}`}>{renderCell(column, row[column.key] ?? '')}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
