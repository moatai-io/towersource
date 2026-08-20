import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceAppDefinition } from './workspace-app-definition';

export function WorkspaceAppDefinitionViewer({
  definition,
  onClose,
}: {
  definition: WorkspaceAppDefinition;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const source = definition.source;
  const definitionJson = React.useMemo(() => JSON.stringify(definition, null, 2), [definition]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-4 dark:bg-black/60 sm:items-center">
      <section className="max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 dark:border-surface-700 dark:bg-surface-950 dark:shadow-black/40">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-surface-800">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.12em] text-blue-700 dark:text-primary-200">{t('workspaceApps.definition.title')}</div>
            <h2 className="mt-1 text-xl font-bold text-slate-950 dark:text-surface-50">{definition.name}</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-surface-400">{t('workspaceApps.definition.description')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200 dark:hover:bg-surface-850"
          >
            {t('workspaceApps.close')}
          </button>
        </div>

        <div className="grid gap-4 overflow-auto p-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="space-y-3 text-sm">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/70">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-surface-500">{t('workspaceApps.definition.dataConnection')}</div>
              <div className="mt-2 space-y-1 text-slate-700 dark:text-surface-300">
                <div><span className="text-slate-500 dark:text-surface-500">{t('workspaceApps.definition.provider')}</span> {source?.provider ?? 'sample'}</div>
                {'databasePath' in (source || {}) && source?.databasePath && <div><span className="text-slate-500 dark:text-surface-500">{t('workspaceApps.definition.file')}</span> {source.databasePath}</div>}
                {'connectionId' in (source || {}) && source?.connectionId && <div><span className="text-slate-500 dark:text-surface-500">{t('workspaceApps.definition.connection')}</span> {source.connectionId}</div>}
                {definition.sourcePath && <div><span className="text-slate-500 dark:text-surface-500">{t('workspaceApps.definition.configuration')}</span> {definition.sourcePath}</div>}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/70">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-surface-500">{t('workspaceApps.definition.table')}</div>
              <div className="mt-2 text-slate-700 dark:text-surface-300">{definition.tableView.columns.map((column) => column.label).join(', ')}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
              {t('workspaceApps.definition.advancedHint')}
            </div>
          </div>

          <details className="rounded-xl border border-slate-200 bg-slate-50 dark:border-surface-800 dark:bg-black/20">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700 dark:text-surface-300">{t('workspaceApps.definition.showAdvanced')}</summary>
            <pre className="max-h-[52vh] overflow-auto border-t border-slate-200 p-4 text-xs leading-5 text-slate-600 dark:border-surface-800 dark:text-surface-300">
              {definitionJson}
            </pre>
          </details>
        </div>
      </section>
    </div>
  );
}
