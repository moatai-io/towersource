import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session-store';
import { useSettingsStore } from '../../stores/settings-store';
import { createWorkspaceAppDraft, createWorkspaceAppPublishPreview, executeWorkspaceAppAction, fetchWorkspaceAppDefinitions, fetchWorkspaceAppDrafts, fetchWorkspaceAppQueryRows, publishWorkspaceAppDraft, type WorkspaceAppDraftRecord, type WorkspaceAppPublishPreview, type WorkspaceAppPublishResult } from './workspace-app-api';
import { FrappeConnectorPilot } from './FrappeConnectorPilot';
import { sampleWorkspaceAppDefinition } from './sample-definition';
import { WorkspaceAppActionBar } from './WorkspaceAppActionBar';
import type { WorkspaceAppField } from './workspace-app-definition';
import { WorkspaceAppBuilderPanel } from './WorkspaceAppBuilderPanel';
import { WorkspaceAppDashboard } from './WorkspaceAppDashboard';
import { WorkspaceAppDefinitionViewer } from './WorkspaceAppDefinitionViewer';
import { applyWorkspaceAppDraftPreview } from './workspace-app-draft-preview';
import { WorkspaceAppRecordPanel, type WorkspaceAppRecordMode } from './WorkspaceAppRecordPanel';
import { WorkspaceAppSidebar } from './WorkspaceAppSidebar';
import { WorkspaceAppTableView } from './WorkspaceAppTableView';
import { useConfirm } from '../../hooks/useDialog';

export function WorkspaceAppsHome() {
  const workspaceAppsMode = useSettingsStore((s) => s.serverConfig?.workspaceAppsMode ?? 'local-metadata');
  return workspaceAppsMode === 'frappe-connector-pilot'
    ? <FrappeConnectorPilot />
    : <LocalMetadataWorkspaceAppsHome />;
}

function LocalMetadataWorkspaceAppsHome() {
  const { t } = useTranslation('common');
  const confirm = useConfirm();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const projectId = React.useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.projectId ?? null,
    [activeSessionId, sessions],
  );
  const [definitions, setDefinitions] = React.useState([sampleWorkspaceAppDefinition]);
  const [sourceState, setSourceState] = React.useState<'sample' | 'workspace' | 'error'>('sample');
  const [liveRows, setLiveRows] = React.useState<Array<Record<string, string>> | null>(null);
  const [draftPreviewActive, setDraftPreviewActive] = React.useState(false);
  const [definitionViewerOpen, setDefinitionViewerOpen] = React.useState(false);
  const [activeMenuId, setActiveMenuId] = React.useState('dashboard');
  const [notice, setNotice] = React.useState('');
  const [searchValue, setSearchValue] = React.useState('');
  const [selectedRowIndex, setSelectedRowIndex] = React.useState<number | null>(null);
  const [selectedRow, setSelectedRow] = React.useState<Record<string, string> | null>(null);
  const [recordMode, setRecordMode] = React.useState<WorkspaceAppRecordMode>('detail');
  const [recordActionState, setRecordActionState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [actionVersion, setActionVersion] = React.useState(0);
  const [draftSaveState, setDraftSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedDraftId, setSavedDraftId] = React.useState<string | null>(null);
  const [savedDrafts, setSavedDrafts] = React.useState<WorkspaceAppDraftRecord[]>([]);
  const [publishPreviewState, setPublishPreviewState] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [publishPreview, setPublishPreview] = React.useState<WorkspaceAppPublishPreview | null>(null);
  const [publishState, setPublishState] = React.useState<'idle' | 'publishing' | 'published' | 'error'>('idle');
  const [publishResult, setPublishResult] = React.useState<WorkspaceAppPublishResult | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSavedDrafts([]);
    setPublishPreviewState('idle');
    setPublishPreview(null);
    setPublishState('idle');
    setPublishResult(null);
    fetchWorkspaceAppDefinitions(projectId)
      .then((apps) => {
        if (cancelled) return;
        if (apps.length > 0) {
          setDefinitions(apps);
          setActiveMenuId(apps[0]?.menu[0]?.id ?? 'dashboard');
          setDraftPreviewActive(false);
          setDraftSaveState('idle');
          setSavedDraftId(null);
          setLiveRows(null);
          setSelectedRowIndex(null);
          setSelectedRow(null);
          setRecordMode('detail');
          setRecordActionState('idle');
          setSourceState('workspace');
        } else {
          setDefinitions([sampleWorkspaceAppDefinition]);
          setActiveMenuId(sampleWorkspaceAppDefinition.menu[0]?.id ?? 'dashboard');
          setDraftPreviewActive(false);
          setDraftSaveState('idle');
          setSavedDraftId(null);
          setLiveRows(null);
          setSelectedRowIndex(null);
          setSelectedRow(null);
          setRecordMode('detail');
          setRecordActionState('idle');
          setSourceState('sample');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setDefinitions([sampleWorkspaceAppDefinition]);
        setActiveMenuId(sampleWorkspaceAppDefinition.menu[0]?.id ?? 'dashboard');
        setDraftPreviewActive(false);
        setDraftSaveState('idle');
        setSavedDraftId(null);
        setLiveRows(null);
        setSelectedRowIndex(null);
        setSelectedRow(null);
        setRecordMode('detail');
        setRecordActionState('idle');
        setSourceState('error');
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const definition = definitions[0] ?? sampleWorkspaceAppDefinition;
  const visibleDefinition = React.useMemo(
    () => applyWorkspaceAppDraftPreview(definition, draftPreviewActive),
    [definition, draftPreviewActive],
  );

  React.useEffect(() => {
    let cancelled = false;
    fetchWorkspaceAppDrafts({ projectId, appId: definition.id, limit: 5 })
      .then((drafts) => {
        if (cancelled) return;
        setSavedDrafts(drafts);
      })
      .catch(() => {
        if (cancelled) return;
        setSavedDrafts([]);
      });
    return () => { cancelled = true; };
  }, [definition.id, projectId]);

  React.useEffect(() => {
    let cancelled = false;
    fetchWorkspaceAppQueryRows({ projectId, appId: definition.id, queryId: definition.tableView.queryId })
      .then((result) => {
        if (cancelled) return;
        setLiveRows(result?.rows?.length ? result.rows : null);
      })
      .catch(() => {
        if (cancelled) return;
        setLiveRows(null);
      });
    return () => { cancelled = true; };
  }, [actionVersion, definition.id, definition.tableView.queryId, projectId]);

  const handleSaveDraft = React.useCallback(async () => {
    if (!definition.builder.draftPreview) return;
    setDraftSaveState('saving');
    setSavedDraftId(null);
    try {
      const result = await createWorkspaceAppDraft({ projectId, appId: definition.id, draftPreview: definition.builder.draftPreview });
      setSavedDraftId(result?.id ?? null);
      if (result) setSavedDrafts((drafts) => [result, ...drafts.filter((draft) => draft.id !== result.id)].slice(0, 5));
      setDraftSaveState('saved');
    } catch {
      setDraftSaveState('error');
    }
  }, [definition.builder.draftPreview, definition.id, projectId]);

  const handlePreviewPublish = React.useCallback(async (draftId: string) => {
    setPublishPreviewState('loading');
    setPublishPreview(null);
    setPublishState('idle');
    setPublishResult(null);
    try {
      const preview = await createWorkspaceAppPublishPreview({ projectId, appId: definition.id, draftId });
      setPublishPreview(preview);
      setPublishPreviewState(preview ? 'ready' : 'error');
    } catch {
      setPublishPreviewState('error');
    }
  }, [definition.id, projectId]);

  const handlePublish = React.useCallback(async () => {
    if (!publishPreview) return;
    const confirmed = await confirm({
      title: t('workspaceApps.publishConfirm.title'),
      message: t('workspaceApps.publishConfirm.message'),
      confirmLabel: t('workspaceApps.publishConfirm.confirm'),
    });
    if (!confirmed) return;
    setPublishState('publishing');
    setPublishResult(null);
    try {
      const result = await publishWorkspaceAppDraft({
        projectId,
        appId: definition.id,
        draftId: publishPreview.draftId,
        previewHash: publishPreview.previewHash,
        expectedBeforeHash: publishPreview.beforeHash,
        confirmed: true,
      });
      setPublishResult(result);
      setPublishState(result ? 'published' : 'error');
    } catch {
      setPublishState('error');
    }
  }, [confirm, definition.id, projectId, publishPreview, t]);

  const activeMenuItem = visibleDefinition.menu.find((item) => item.id === activeMenuId) ?? visibleDefinition.menu[0];
  const menuHasLiveTable = activeMenuId === 'dashboard' || activeMenuId === visibleDefinition.tableView.id || activeMenuId === visibleDefinition.tableView.queryId || activeMenuId === 'accounts' || activeMenuId === 'customers';
  const tableView = React.useMemo(() => {
    const baseRows = liveRows ? liveRows : visibleDefinition.tableView.rows;
    const normalizedSearch = searchValue.trim().toLowerCase();
    const filteredRows = normalizedSearch
      ? baseRows.filter((row) => Object.values(row).some((value) => String(value).toLowerCase().includes(normalizedSearch)))
      : baseRows;
    if (menuHasLiveTable) return { ...visibleDefinition.tableView, rows: filteredRows };
    return {
      ...visibleDefinition.tableView,
      id: `${visibleDefinition.tableView.id}-${activeMenuId}`,
      title: t('workspaceApps.home.listTitle', { name: activeMenuItem?.label ?? t('workspaceApps.work') }),
      subtitle: t('workspaceApps.home.unconnectedTable'),
      statusLabel: t('workspaceApps.home.preparing'),
      rows: [],
    };
  }, [activeMenuId, activeMenuItem?.label, liveRows, menuHasLiveTable, t, visibleDefinition.tableView]);
  const recordFields: WorkspaceAppField[] = React.useMemo(() => {
    if (visibleDefinition.fields?.length) return visibleDefinition.fields;
    return visibleDefinition.tableView.columns.map((column) => ({
      id: column.key,
      label: column.label,
      type: column.kind === 'status' || column.kind === 'money' || column.kind === 'date' ? column.kind : 'text',
      sourceColumn: column.key,
      options: column.kind === 'status' ? ['상담중', '제안', '계약', '보류', '준비 중'] : undefined,
    }));
  }, [visibleDefinition.fields, visibleDefinition.tableView.columns]);

  const sourceLabel = sourceState === 'workspace'
    ? (liveRows ? t('workspaceApps.home.connectedData') : t('workspaceApps.home.workScreen'))
    : sourceState === 'error' ? t('workspaceApps.home.sampleConnectionError') : t('workspaceApps.home.sampleScreen');

  const handleExportCsv = React.useCallback(() => {
    const headers = tableView.columns.map((column) => column.label);
    const lines = [headers, ...tableView.rows.map((row) => tableView.columns.map((column) => row[column.key] ?? ''))]
      .map((cells) => cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${definition.id}-${activeMenuId}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(t('workspaceApps.notice.exportedCsv'));
  }, [activeMenuId, definition.id, t, tableView.columns, tableView.rows]);

  const actionIdByType = React.useCallback((type: 'create' | 'update' | 'change-status') => {
    return visibleDefinition.actions?.find((action) => action.type === type)?.id ?? '';
  }, [visibleDefinition.actions]);

  const handleRecordSubmit = React.useCallback(async (mode: WorkspaceAppRecordMode, values: Record<string, string>) => {
    const actionId = mode === 'create' ? actionIdByType('create') : mode === 'status' ? actionIdByType('change-status') : actionIdByType('update');
    const primaryKey = visibleDefinition.record?.primaryKey ?? 'id';
    const recordId = selectedRow?.[primaryKey];
    if (!actionId) {
      setRecordActionState('error');
      setNotice(t('workspaceApps.notice.noSaveAction'));
      return;
    }
    if (mode !== 'create' && !recordId) {
      setRecordActionState('error');
      setNotice(t('workspaceApps.notice.missingRecordId'));
      return;
    }
    setRecordActionState('saving');
    try {
      await executeWorkspaceAppAction({
        projectId,
        appId: definition.id,
        actionId,
        payload: { values, recordId },
      });
      setRecordActionState('saved');
      setRecordMode('detail');
      setSelectedRow(null);
      setSelectedRowIndex(null);
      setActionVersion((version) => version + 1);
      setNotice(mode === 'create' ? t('workspaceApps.notice.created') : mode === 'status' ? t('workspaceApps.notice.statusChanged') : t('workspaceApps.notice.updated'));
    } catch {
      setRecordActionState('error');
      setNotice(t('workspaceApps.notice.saveFailed'));
    }
  }, [actionIdByType, definition.id, projectId, selectedRow, t, visibleDefinition.record?.primaryKey]);

  return (
    <div className="h-full overflow-auto bg-slate-100 text-slate-950 dark:bg-surface-950 dark:text-surface-100">
      <div className="mx-auto flex min-h-full max-w-[96rem] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-800 dark:border-primary-500/25 dark:bg-primary-500/10 dark:text-primary-200">
              {activeMenuItem?.label ?? t('workspaceApps.work')}
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500 dark:bg-surface-950/50 dark:text-surface-400">{draftPreviewActive ? t('workspaceApps.home.previewActive') : sourceLabel}</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 dark:text-surface-50">{visibleDefinition.title}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-surface-400">{visibleDefinition.description}</p>
            {notice && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">{notice}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setDefinitionViewerOpen(true)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
            >
              {t('workspaceApps.home.adminSettings')}
            </button>
          </div>
        </header>

        <WorkspaceAppDashboard metrics={visibleDefinition.metrics} />

        <WorkspaceAppActionBar
          selectedCount={selectedRow ? 1 : 0}
          searchValue={searchValue}
          actions={visibleDefinition.actions}
          onSearchChange={(value) => {
            setSearchValue(value);
            setSelectedRowIndex(null);
            setSelectedRow(null);
            setRecordMode('detail');
          }}
          onCreate={() => {
            setRecordMode('create');
            setRecordActionState('idle');
            setSelectedRowIndex(null);
            setSelectedRow(null);
            setNotice(t('workspaceApps.notice.createOpened'));
          }}
          onEdit={() => {
            if (!selectedRow) return;
            setRecordMode('edit');
            setRecordActionState('idle');
            setNotice(t('workspaceApps.notice.editOpened'));
          }}
          onChangeStatus={() => {
            if (!selectedRow) return;
            setRecordMode('status');
            setRecordActionState('idle');
            setNotice(t('workspaceApps.notice.statusOpened'));
          }}
          onExport={handleExportCsv}
        />

        <div className="grid min-h-[28rem] gap-3 lg:grid-cols-[15rem_minmax(0,1fr)_22rem]">
          <WorkspaceAppSidebar
            title={visibleDefinition.menuTitle}
            items={visibleDefinition.menu}
            activeId={activeMenuId}
            onSelect={(id) => {
              setActiveMenuId(id);
              setSelectedRowIndex(null);
              setSelectedRow(null);
              setRecordMode('detail');
              setRecordActionState('idle');
              const item = visibleDefinition.menu.find((candidate) => candidate.id === id);
              setNotice(item?.live ? '' : t('workspaceApps.notice.menuPreparing', { name: item?.label ?? t('workspaceApps.thisMenu') }));
            }}
          />
          <WorkspaceAppTableView
            view={tableView}
            activeSectionLabel={activeMenuItem?.label}
            selectedRowIndex={selectedRowIndex}
            onSelectRow={(row, rowIndex) => {
              setSelectedRow(row);
              setSelectedRowIndex(rowIndex);
              setRecordMode('detail');
              setRecordActionState('idle');
              setNotice(t('workspaceApps.notice.detailsShown'));
            }}
          />
          <div className="space-y-3">
            <WorkspaceAppRecordPanel
              mode={recordMode}
              fields={recordFields}
              selectedRow={selectedRow}
              sectionLabel={activeMenuItem?.label}
              actionState={recordActionState}
              onModeChange={(mode) => {
                setRecordMode(mode);
                setRecordActionState('idle');
              }}
              onSubmit={handleRecordSubmit}
              onClose={() => {
                setRecordMode('detail');
                setRecordActionState('idle');
                setSelectedRow(null);
                setSelectedRowIndex(null);
              }}
            />
            <details className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
              <summary className="cursor-pointer px-4 py-3 text-[13px] font-bold text-slate-700 dark:text-surface-200">{t('workspaceApps.home.adminBuilder')}</summary>
              <div className="border-t border-slate-200 p-3 dark:border-surface-800">
                <WorkspaceAppBuilderPanel
                  builder={definition.builder}
                  previewActive={draftPreviewActive}
                  draftSaveState={draftSaveState}
                  savedDraftId={savedDraftId}
                  savedDrafts={savedDrafts}
                  publishPreviewState={publishPreviewState}
                  publishPreview={publishPreview}
                  publishState={publishState}
                  publishResult={publishResult}
                  onTogglePreview={() => setDraftPreviewActive((active) => !active)}
                  onSaveDraft={definition.builder.draftPreview ? handleSaveDraft : undefined}
                  onPreviewPublish={handlePreviewPublish}
                  onPublish={publishPreview ? handlePublish : undefined}
                />
              </div>
            </details>
          </div>
        </div>
      </div>
      {definitionViewerOpen && (
        <WorkspaceAppDefinitionViewer definition={definition} onClose={() => setDefinitionViewerOpen(false)} />
      )}
    </div>
  );
}
