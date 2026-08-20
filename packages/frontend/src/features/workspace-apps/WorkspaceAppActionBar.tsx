import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceAppAction } from './workspace-app-definition';

function actionLabel(actions: WorkspaceAppAction[] | undefined, type: WorkspaceAppAction['type'], fallback: string) {
  return actions?.find((action) => action.type === type)?.label ?? fallback;
}

export function WorkspaceAppActionBar({
  selectedCount,
  searchValue,
  actions,
  onSearchChange,
  onCreate,
  onEdit,
  onChangeStatus,
  onExport,
  canCreate = true,
  canEdit = true,
  canChangeStatus = true,
}: {
  selectedCount: number;
  searchValue: string;
  actions?: WorkspaceAppAction[];
  onSearchChange: (value: string) => void;
  onCreate: () => void;
  onEdit: () => void;
  onChangeStatus: () => void;
  onExport: () => void;
  canCreate?: boolean;
  canEdit?: boolean;
  canChangeStatus?: boolean;
}) {
  const { t } = useTranslation('common');
  const hasSelection = selectedCount > 0;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCreate}
            disabled={!canCreate}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-primary-500 dark:hover:bg-primary-400"
          >
            {actionLabel(actions, 'create', t('workspaceApps.actions.create'))}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={!canEdit || !hasSelection}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
          >
            {actionLabel(actions, 'update', t('workspaceApps.actions.update'))}
          </button>
          <button
            type="button"
            onClick={onChangeStatus}
            disabled={!canChangeStatus || !hasSelection}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
          >
            {actionLabel(actions, 'change-status', t('workspaceApps.actions.changeStatus'))}
          </button>
          <button
            type="button"
            onClick={onExport}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
          >
            {actionLabel(actions, 'export', t('workspaceApps.actions.exportCsv'))}
          </button>
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-300 xl:max-w-md">
          <span className="shrink-0 text-[12px] font-bold text-slate-500 dark:text-surface-500">{t('workspaceApps.actions.search')}</span>
          <input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('workspaceApps.actions.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-surface-100 dark:placeholder:text-surface-600"
          />
        </label>
      </div>
    </section>
  );
}
