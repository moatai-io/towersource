import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSessionStore } from '../../stores/session-store';
import { fetchFrappeConnectionReadiness, fetchFrappeObjectSchema, fetchFrappeObjects, fetchFrappeRecord, fetchFrappeRecords, fetchMockFrappeObjectSchema, fetchMockFrappeObjects, fetchMockFrappeRecords, runMockFrappeAction, type FrappeConnectionReadiness } from './workspace-app-api';
import { WorkspaceAppActionBar } from './WorkspaceAppActionBar';
import { WorkspaceAppRecordPanel, type WorkspaceAppRecordMode } from './WorkspaceAppRecordPanel';
import { WorkspaceAppTableView } from './WorkspaceAppTableView';
import type { BusinessFieldKind, BusinessObjectSchema, BusinessObjectSummary, RecordList } from './diy-erp-connector';
import type { WorkspaceAppAction, WorkspaceAppField, WorkspaceAppTableColumn, WorkspaceAppTableView as WorkspaceAppTableViewDefinition } from './workspace-app-definition';

type FrappePilotSourceMode = 'mock' | 'real-readonly';

type TemplatePlanKind = 'field' | 'workflow' | 'report';

interface TemplatePlanPreview {
  kind: TemplatePlanKind;
  title: string;
  targetDoctype: string;
  summary: string;
  steps: string[];
  risks: string[];
  nextAction: string;
}

function templatePlanPrompts(): string[] {
  return [
    i18n.t('workspaceApps.frappe.prompts.field'),
    i18n.t('workspaceApps.frappe.prompts.workflow'),
    i18n.t('workspaceApps.frappe.prompts.report'),
  ];
}

const defaultFrappeConnectionId = 'frappe-main';
const defaultFrappeDoctype = 'Customer';
const defaultFrappeBusinessDoctypes = ['Customer', 'Sales Invoice', 'Item', 'Supplier', 'Lead'];

const activeChoiceClass = 'border-blue-500 bg-blue-600 text-white shadow-sm dark:border-primary-400 dark:bg-primary-500';
const inactiveChoiceClass = 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-300 dark:hover:bg-surface-850';
const activeSourceClass = 'border-blue-500 bg-blue-600 text-white';
const inactiveSourceClass = 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200 dark:hover:bg-surface-850';

function businessLabelForDoctype(doctype: string): string {
  const normalized = doctype.trim().toLowerCase();
  if (normalized === 'customer') return i18n.t('workspaceApps.frappe.business.customer');
  if (normalized === 'sales invoice') return i18n.t('workspaceApps.frappe.business.salesInvoice');
  if (normalized === 'item') return i18n.t('workspaceApps.frappe.business.item');
  if (normalized === 'supplier') return i18n.t('workspaceApps.frappe.business.supplier');
  if (normalized === 'lead') return i18n.t('workspaceApps.frappe.business.lead');
  return doctype.trim() || i18n.t('workspaceApps.frappe.business.work');
}

function businessDescriptionForDoctype(doctype: string): string {
  const normalized = doctype.trim().toLowerCase();
  if (normalized === 'customer') return i18n.t('workspaceApps.frappe.businessDescription.customer');
  if (normalized === 'sales invoice') return i18n.t('workspaceApps.frappe.businessDescription.salesInvoice');
  if (normalized === 'item') return i18n.t('workspaceApps.frappe.businessDescription.item');
  return i18n.t('workspaceApps.frappe.businessDescription.default');
}

function buildTemplatePlanPreview(prompt: string, doctype: string): TemplatePlanPreview {
  const businessLabel = businessLabelForDoctype(doctype);
  if (prompt.includes('사업자등록번호')) {
    return {
      kind: 'field',
      title: i18n.t('workspaceApps.frappe.plan.field.title'),
      targetDoctype: doctype,
      summary: i18n.t('workspaceApps.frappe.plan.field.summary', { name: businessLabel }),
      steps: [
        i18n.t('workspaceApps.frappe.plan.field.step1', { doctype }),
        i18n.t('workspaceApps.frappe.plan.field.step2'),
        i18n.t('workspaceApps.frappe.plan.field.step3'),
      ],
      risks: [i18n.t('workspaceApps.frappe.plan.field.risk1'), i18n.t('workspaceApps.frappe.plan.field.risk2')],
      nextAction: i18n.t('workspaceApps.frappe.plan.field.next'),
    };
  }
  if (prompt.includes('승인 흐름')) {
    return {
      kind: 'workflow',
      title: i18n.t('workspaceApps.frappe.plan.workflow.title'),
      targetDoctype: doctype,
      summary: i18n.t('workspaceApps.frappe.plan.workflow.summary', { name: businessLabel }),
      steps: [
        i18n.t('workspaceApps.frappe.plan.workflow.step1', { doctype }),
        i18n.t('workspaceApps.frappe.plan.workflow.step2'),
        i18n.t('workspaceApps.frappe.plan.workflow.step3'),
      ],
      risks: [i18n.t('workspaceApps.frappe.plan.workflow.risk1'), i18n.t('workspaceApps.frappe.plan.workflow.risk2')],
      nextAction: i18n.t('workspaceApps.frappe.plan.workflow.next'),
    };
  }
  return {
    kind: 'report',
    title: i18n.t('workspaceApps.frappe.plan.report.title'),
    targetDoctype: doctype,
    summary: i18n.t('workspaceApps.frappe.plan.report.summary', { name: businessLabel }),
    steps: [
      i18n.t('workspaceApps.frappe.plan.report.step1'),
      i18n.t('workspaceApps.frappe.plan.report.step2'),
      i18n.t('workspaceApps.frappe.plan.report.step3'),
    ],
    risks: [i18n.t('workspaceApps.frappe.plan.report.risk1'), i18n.t('workspaceApps.frappe.plan.report.risk2')],
    nextAction: i18n.t('workspaceApps.frappe.plan.report.next'),
  };
}

function fieldKindToTableKind(kind: BusinessFieldKind): WorkspaceAppTableColumn['kind'] {
  if (kind === 'money') return 'money';
  if (kind === 'date') return 'date';
  if (kind === 'status' || kind === 'select') return 'status';
  return 'text';
}

function fieldKindToFormType(kind: BusinessFieldKind): WorkspaceAppField['type'] {
  if (kind === 'money') return 'money';
  if (kind === 'date') return 'date';
  if (kind === 'status') return 'status';
  if (kind === 'select') return 'select';
  if (kind === 'boolean') return 'select';
  return 'text';
}

function schemaToFields(schema: BusinessObjectSchema | null): WorkspaceAppField[] {
  if (!schema) return [];
  return schema.fields
    .filter((field) => field.kind !== 'child-table')
    .map((field) => ({
      id: field.id,
      label: field.label,
      type: fieldKindToFormType(field.kind),
      required: field.required,
      options: field.kind === 'boolean' ? ['false', 'true'] : field.options,
      sourceColumn: field.id,
    }));
}

function schemaToActions(schema: BusinessObjectSchema | null, sourceMode: FrappePilotSourceMode): WorkspaceAppAction[] {
  const transition = schema?.transitions[0];
  return [
    { id: 'create', label: i18n.t('workspaceApps.frappe.actions.create'), type: 'create' },
    { id: 'update', label: i18n.t('workspaceApps.frappe.actions.update'), type: 'update' },
    { id: transition?.id ?? 'transition', label: transition?.label ?? i18n.t('workspaceApps.frappe.actions.changeStatus'), type: 'change-status', field: schema?.statusField },
    { id: 'export', label: sourceMode === 'mock' ? i18n.t('workspaceApps.frappe.actions.exportCsv') : i18n.t('workspaceApps.frappe.actions.export'), type: 'export' },
  ];
}

function schemaToTable(schema: BusinessObjectSchema | null, records: RecordList | null, sourceMode: FrappePilotSourceMode): WorkspaceAppTableViewDefinition {
  const fields = schema?.fields.filter((field) => field.kind !== 'child-table').slice(0, 5) ?? [];
  return {
    id: schema?.object.id ?? 'frappe-pilot',
    title: schema ? i18n.t('workspaceApps.frappe.table.previewTitle', { name: businessLabelForDoctype(schema.object.doctype) }) : i18n.t('workspaceApps.frappe.table.erpPreview'),
    subtitle: schema
      ? i18n.t('workspaceApps.frappe.table.subtitle', { name: businessLabelForDoctype(schema.object.doctype), source: sourceMode === 'mock' ? i18n.t('workspaceApps.frappe.sampleSource') : i18n.t('workspaceApps.frappe.readOnlySource') })
      : i18n.t('workspaceApps.frappe.table.defaultSubtitle'),
    statusLabel: sourceMode === 'mock' ? i18n.t('workspaceApps.frappe.sampleData') : i18n.t('workspaceApps.frappe.readOnlyErp'),
    columns: fields.map((field) => ({ key: field.id, label: field.label, kind: fieldKindToTableKind(field.kind) })),
    rows: records?.rows ?? [],
  };
}

function frappeObjectIdFromDoctype(doctype: string): string {
  return (doctype.trim() || defaultFrappeDoctype).toLowerCase().replace(/\s+/g, '-');
}

function realObjectFromDoctype(doctype: string): BusinessObjectSummary {
  const cleanDoctype = doctype.trim() || defaultFrappeDoctype;
  return {
    id: frappeObjectIdFromDoctype(cleanDoctype),
    label: businessLabelForDoctype(cleanDoctype),
    backend: 'frappe',
    doctype: cleanDoctype,
    description: businessDescriptionForDoctype(cleanDoctype),
  };
}

const defaultFrappeBusinessObjects = defaultFrappeBusinessDoctypes.map(realObjectFromDoctype);

function realObjectsForDoctype(doctype: string): BusinessObjectSummary[] {
  const customObject = realObjectFromDoctype(doctype);
  if (defaultFrappeBusinessObjects.some((object) => object.id === customObject.id)) return defaultFrappeBusinessObjects;
  return [customObject, ...defaultFrappeBusinessObjects];
}

export function FrappeConnectorPilot() {
  const { t } = useTranslation('common');
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const projectId = React.useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.projectId ?? null,
    [activeSessionId, sessions],
  );
  const [sourceMode, setSourceMode] = React.useState<FrappePilotSourceMode>('real-readonly');
  const [connectionId, setConnectionId] = React.useState(defaultFrappeConnectionId);
  const [appliedConnectionId, setAppliedConnectionId] = React.useState(defaultFrappeConnectionId);
  const [doctypeInput, setDoctypeInput] = React.useState(defaultFrappeDoctype);
  const [appliedDoctype, setAppliedDoctype] = React.useState(defaultFrappeDoctype);
  const [objects, setObjects] = React.useState<BusinessObjectSummary[]>([]);
  const [activeObjectId, setActiveObjectId] = React.useState('customer');
  const [schema, setSchema] = React.useState<BusinessObjectSchema | null>(null);
  const [records, setRecords] = React.useState<RecordList | null>(null);
  const [searchValue, setSearchValue] = React.useState('');
  const [selectedRow, setSelectedRow] = React.useState<Record<string, string> | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = React.useState<number | null>(null);
  const [selectedDeskUrl, setSelectedDeskUrl] = React.useState<string | null>(null);
  const [recordMode, setRecordMode] = React.useState<WorkspaceAppRecordMode>('detail');
  const [actionState, setActionState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [connectionState, setConnectionState] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [readiness, setReadiness] = React.useState<FrappeConnectionReadiness | null>(null);
  const [doctypeCandidates, setDoctypeCandidates] = React.useState<BusinessObjectSummary[]>([]);
  const [doctypeCandidateSearch, setDoctypeCandidateSearch] = React.useState('');
  const [doctypeCandidateState, setDoctypeCandidateState] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [templatePlanPreview, setTemplatePlanPreview] = React.useState<TemplatePlanPreview | null>(null);
  const [notice, setNotice] = React.useState('');
  const [refreshKey, setRefreshKey] = React.useState(0);

  const isRealReadOnly = sourceMode === 'real-readonly';
  const canWriteThroughConnector = sourceMode === 'mock';

  React.useEffect(() => {
    let cancelled = false;
    setSelectedRow(null);
    setSelectedRowIndex(null);
    setSelectedDeskUrl(null);
    setReadiness(null);
    setRecordMode('detail');
    setActionState('idle');
    if (sourceMode === 'real-readonly') {
      const nextObjects = realObjectsForDoctype(appliedDoctype);
      setObjects(nextObjects);
      if (!nextObjects.some((object) => object.id === activeObjectId)) setActiveObjectId(frappeObjectIdFromDoctype(appliedDoctype));
      return () => { cancelled = true; };
    }
    fetchMockFrappeObjects(projectId).then((items) => {
      if (cancelled) return;
      setObjects(items);
      if (!items.some((item) => item.id === activeObjectId)) setActiveObjectId(items[0]?.id ?? 'customer');
    }).catch(() => {
      if (!cancelled) setNotice(t('workspaceApps.frappe.notice.mockObjectsFailed'));
    });
    return () => { cancelled = true; };
  }, [activeObjectId, appliedDoctype, projectId, sourceMode]);

  React.useEffect(() => {
    let cancelled = false;
    setSelectedRow(null);
    setSelectedRowIndex(null);
    setSelectedDeskUrl(null);
    setRecordMode('detail');
    setActionState('idle');

    if (sourceMode === 'real-readonly') {
      if (!projectId || !appliedConnectionId.trim() || !appliedDoctype.trim()) {
        setSchema(null);
        setRecords(null);
        setReadiness(null);
        setConnectionState('idle');
        setNotice(t('workspaceApps.frappe.notice.connectionRequired'));
        return () => { cancelled = true; };
      }
      setConnectionState('loading');
      fetchFrappeObjectSchema({ projectId, connectionId: appliedConnectionId.trim(), doctype: appliedDoctype.trim() })
        .then((nextSchema) => {
          if (cancelled) return null;
          setSchema(nextSchema);
          const fields = nextSchema?.fields.filter((field) => field.kind !== 'child-table').slice(0, 8).map((field) => field.id) ?? ['name'];
          return fetchFrappeRecords({ projectId, connectionId: appliedConnectionId.trim(), doctype: appliedDoctype.trim(), fields, search: searchValue, limit: 100 });
        })
        .then((nextRecords) => {
          if (!cancelled && nextRecords) {
            setRecords(nextRecords);
            setConnectionState('ready');
            setNotice(t('workspaceApps.frappe.notice.readOnlyLoaded'));
          }
        })
        .catch(() => {
          if (cancelled) return;
          setSchema(null);
          setRecords(null);
          setConnectionState('error');
        setNotice(t('workspaceApps.frappe.notice.connectionLoadFailed'));
        });
      return () => { cancelled = true; };
    }

    fetchMockFrappeObjectSchema({ projectId, objectId: activeObjectId })
      .then((nextSchema) => {
        if (cancelled) return null;
        setSchema(nextSchema);
        return fetchMockFrappeRecords({ projectId, objectId: activeObjectId, search: searchValue, limit: 100 });
      })
      .then((nextRecords) => {
        if (!cancelled && nextRecords) setRecords(nextRecords);
      })
      .catch(() => {
        if (cancelled) return;
        setSchema(null);
        setRecords(null);
        setNotice(t('workspaceApps.frappe.notice.mockDataFailed'));
      });
    return () => { cancelled = true; };
  }, [activeObjectId, appliedConnectionId, appliedDoctype, projectId, refreshKey, searchValue, sourceMode]);

  const fields = React.useMemo(() => schemaToFields(schema), [schema]);
  const actions = React.useMemo(() => schemaToActions(schema, sourceMode), [schema, sourceMode]);
  const table = React.useMemo(() => schemaToTable(schema, records, sourceMode), [schema, records, sourceMode]);
  const activeObject = objects.find((object) => object.id === activeObjectId) ?? objects[0];

  const handleReadinessCheck = React.useCallback(async () => {
    if (!projectId) return;
    const nextConnectionId = connectionId.trim();
    if (!nextConnectionId) {
      setConnectionState('idle');
      setReadiness(null);
      setNotice(t('workspaceApps.frappe.notice.connectionIdRequired'));
      return;
    }
    setConnectionState('loading');
    setReadiness(null);
    try {
      const nextReadiness = await fetchFrappeConnectionReadiness({ projectId, connectionId: nextConnectionId });
      setReadiness(nextReadiness);
      setConnectionState(nextReadiness?.ready ? 'ready' : 'error');
      setNotice(nextReadiness?.ready
        ? t('workspaceApps.frappe.notice.ready', { host: nextReadiness.siteHost })
        : t('workspaceApps.frappe.notice.credentialIncomplete'));
    } catch {
      setConnectionState('error');
      setNotice(t('workspaceApps.frappe.notice.readinessFailed'));
    }
  }, [connectionId, projectId]);

  const applyFrappeObject = React.useCallback((object: BusinessObjectSummary) => {
    setSourceMode('real-readonly');
    setActiveObjectId(object.id);
    setAppliedConnectionId(connectionId.trim() || defaultFrappeConnectionId);
    setAppliedDoctype(object.doctype);
    setDoctypeInput(object.doctype);
    setSelectedRow(null);
    setSelectedRowIndex(null);
    setSelectedDeskUrl(null);
    setRecordMode('detail');
    setReadiness(null);
    setRefreshKey((key) => key + 1);
  }, [connectionId]);

  const handleLoadDoctypeCandidates = React.useCallback(async () => {
    const nextConnectionId = connectionId.trim();
    if (!projectId || !nextConnectionId) {
      setDoctypeCandidateState('idle');
      setNotice(t('workspaceApps.frappe.notice.structureConnectionRequired'));
      return;
    }
    setDoctypeCandidateState('loading');
    try {
      const nextCandidates = await fetchFrappeObjects({ projectId, connectionId: nextConnectionId, search: doctypeCandidateSearch, limit: 80 });
      setDoctypeCandidates(nextCandidates);
      setDoctypeCandidateState('ready');
      setNotice(nextCandidates.length ? t('workspaceApps.frappe.notice.candidatesLoaded', { count: nextCandidates.length }) : t('workspaceApps.frappe.notice.noCandidates'));
    } catch {
      setDoctypeCandidates([]);
      setDoctypeCandidateState('error');
      setNotice(t('workspaceApps.frappe.notice.structureLoadFailed'));
    }
  }, [connectionId, doctypeCandidateSearch, projectId]);

  const handleTemplatePlanPrompt = React.useCallback((prompt: string) => {
    const targetDoctype = activeObject?.doctype ?? appliedDoctype;
    setTemplatePlanPreview(buildTemplatePlanPreview(prompt, targetDoctype));
    setNotice(t('workspaceApps.frappe.notice.planCreated', { prompt }));
  }, [activeObject?.doctype, appliedDoctype]);

  const handleSubmit = React.useCallback(async (mode: WorkspaceAppRecordMode, values: Record<string, string>) => {
    if (!schema) return;
    if (isRealReadOnly) {
      setActionState('error');
      setNotice(t('workspaceApps.frappe.notice.writeDisabled'));
      return;
    }
    setActionState('saving');
    try {
      if (mode === 'create') {
        await runMockFrappeAction({ projectId, objectId: activeObjectId, actionId: 'create', values });
        setNotice(t('workspaceApps.frappe.notice.mockCreated'));
      } else if (mode === 'status') {
        const transition = schema.transitions[0];
        if (!selectedRow?.id || !transition) throw new Error('transition unavailable');
        await runMockFrappeAction({ projectId, objectId: activeObjectId, actionId: `transition:${transition.id}`, recordId: selectedRow.id, values: {} });
        setNotice(t('workspaceApps.frappe.notice.transitionComplete', { label: transition.label }));
      } else {
        if (!selectedRow?.id) throw new Error('record unavailable');
        await runMockFrappeAction({ projectId, objectId: activeObjectId, actionId: 'update', recordId: selectedRow.id, values });
        setNotice(t('workspaceApps.frappe.notice.itemSaved'));
      }
      setActionState('saved');
      setRecordMode('detail');
      setSelectedRow(null);
      setSelectedRowIndex(null);
      setRefreshKey((key) => key + 1);
    } catch {
      setActionState('error');
      setNotice(t('workspaceApps.frappe.notice.saveFailed'));
    }
  }, [activeObjectId, isRealReadOnly, projectId, schema, selectedRow]);

  const handleSelectRow = React.useCallback((row: Record<string, string>, rowIndex: number) => {
    setSelectedRow(row);
    setSelectedRowIndex(rowIndex);
    setRecordMode('detail');
    setActionState('idle');
    setSelectedDeskUrl(null);
    if (!isRealReadOnly || !projectId || !appliedConnectionId.trim() || !appliedDoctype.trim()) return;
    const recordId = row.name ?? row.id;
    if (!recordId) return;
    fetchFrappeRecord({ projectId, connectionId: appliedConnectionId.trim(), doctype: appliedDoctype.trim(), recordId })
      .then((detail) => {
        if (detail?.values) setSelectedRow({ ...row, ...detail.values });
        if (detail?.deskUrl) setSelectedDeskUrl(detail.deskUrl);
      })
      .catch(() => setNotice(t('workspaceApps.frappe.notice.detailLoadFailed')));
  }, [appliedConnectionId, appliedDoctype, isRealReadOnly, projectId]);

  const openDeskUrl = selectedDeskUrl ?? schema?.object.deskUrl ?? activeObject?.deskUrl ?? 'https://frappe.example.test/app';
  const activeBusinessLabel = activeObject ? businessLabelForDoctype(activeObject.doctype) : businessLabelForDoctype(appliedDoctype);
  const objectCountLabel = records ? t('workspaceApps.frappe.recordCount', { count: records.rows.length.toLocaleString() }) : connectionState === 'loading' ? t('workspaceApps.frappe.loading') : t('workspaceApps.frappe.waiting');
  const connectionHostLabel = readiness?.deskHost ?? readiness?.siteHost ?? (isRealReadOnly ? appliedConnectionId : t('workspaceApps.frappe.sampleData'));
  const readOnlyNotice = isRealReadOnly
    ? t('workspaceApps.frappe.readOnlyNotice')
    : t('workspaceApps.frappe.mockNotice');

  return (
    <div className="h-full overflow-auto bg-slate-100 text-slate-950 dark:bg-surface-950 dark:text-surface-100">
      <div className="mx-auto flex min-h-full max-w-[96rem] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-bold text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100">
                {t('workspaceApps.frappe.ui.businessApp')}
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500 dark:bg-surface-950/50 dark:text-surface-400">DIY ERP Connector</span>
              </div>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950 dark:text-surface-50">{t('workspaceApps.frappe.ui.title')}</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-surface-400">
                {t('workspaceApps.frappe.ui.description')}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[28rem]">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.selectedTemplate')}</div>
                <div className="mt-1 text-sm font-bold text-slate-900 dark:text-surface-100">{activeBusinessLabel}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.connectionStatus')}</div>
                <div className="mt-1 truncate text-sm font-bold text-slate-900 dark:text-surface-100">{connectionState === 'loading' ? t('workspaceApps.frappe.ui.loading') : isRealReadOnly ? t('workspaceApps.frappe.ui.readOnly') : t('workspaceApps.frappe.ui.sample')}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.preview')}</div>
                <div className="mt-1 text-sm font-bold text-slate-900 dark:text-surface-100">{objectCountLabel}</div>
              </div>
            </div>
          </div>
          {notice && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">{notice}</p>}
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-surface-100">{t('workspaceApps.frappe.ui.structureMap')}</h2>
              <p className="mt-1 text-[12px] text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.structureDescription')}</p>
            </div>
            <a
              href={openDeskUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
            >
              {t('workspaceApps.frappe.ui.openOriginal')}
            </a>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {objects.map((object) => {
              const isActive = object.id === activeObjectId;
              const label = businessLabelForDoctype(object.doctype);
              return (
                <button
                  key={object.id}
                  type="button"
                  onClick={() => {
                    if (isRealReadOnly) applyFrappeObject(object);
                    else setActiveObjectId(object.id);
                  }}
                  className={`rounded-xl border px-3 py-3 text-left transition ${isActive ? activeChoiceClass : inactiveChoiceClass}`}
                >
                  <div className="text-sm font-bold">{label}</div>
                  <div className={`mt-1 line-clamp-2 text-[12px] leading-5 ${isActive ? 'text-blue-100 dark:text-primary-100' : 'text-slate-500 dark:text-surface-500'}`}>{object.description}</div>
                  <div className={`mt-2 text-[11px] ${isActive ? 'text-blue-100 dark:text-primary-100' : 'text-slate-400 dark:text-surface-600'}`}>{sourceMode === 'mock' ? t('workspaceApps.frappe.ui.sampleTemplate') : t('workspaceApps.frappe.ui.frappeTemplate')}</div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-surface-100">{t('workspaceApps.frappe.ui.templateWorkbench')}</h2>
                <p className="mt-1 max-w-2xl text-[13px] leading-5 text-slate-600 dark:text-surface-400">
                  {t('workspaceApps.frappe.ui.workbenchDescription')}
                </p>
              </div>
              <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold text-slate-500 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-400">Preview only</span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {templatePlanPrompts().map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => handleTemplatePlanPrompt(prompt)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-[12px] leading-5 text-slate-600 hover:bg-white dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-400 dark:hover:bg-surface-850"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-[12px] leading-5 text-slate-600 shadow-sm dark:border-surface-800 dark:bg-surface-900/70 dark:text-surface-400">
            {templatePlanPreview ? (
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900 dark:text-surface-100">{templatePlanPreview.title}</div>
                    <div className="mt-1 text-[11px] text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.target', { target: templatePlanPreview.targetDoctype })}</div>
                  </div>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">{t('workspaceApps.frappe.ui.beforeApproval')}</span>
                </div>
                <p className="mt-3 text-slate-700 dark:text-surface-300">{templatePlanPreview.summary}</p>
                <div className="mt-3 font-bold text-slate-800 dark:text-surface-100">{t('workspaceApps.frappe.ui.expectedChanges')}</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {templatePlanPreview.steps.map((step) => <li key={step}>{step}</li>)}
                </ul>
                <div className="mt-3 font-bold text-slate-800 dark:text-surface-100">{t('workspaceApps.frappe.ui.risks')}</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {templatePlanPreview.risks.map((risk) => <li key={risk}>{risk}</li>)}
                </ul>
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-surface-800 dark:bg-surface-950/40">{t('workspaceApps.frappe.ui.next', { action: templatePlanPreview.nextAction })}</div>
              </div>
            ) : (
              <div>
                <div className="font-bold text-slate-900 dark:text-surface-100">{t('workspaceApps.frappe.ui.previewPrinciples')}</div>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>{t('workspaceApps.frappe.ui.principle1')}</li>
                  <li>{t('workspaceApps.frappe.ui.principle2')}</li>
                  <li>{t('workspaceApps.frappe.ui.principle3')}</li>
                </ul>
              </div>
            )}
          </div>
        </section>

        <div className="grid min-h-[32rem] gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <main className="space-y-3">
            {isRealReadOnly ? (
              <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-300 xl:max-w-md">
                    <span className="shrink-0 text-[12px] font-bold text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.search')}</span>
                    <input
                      value={searchValue}
                      onChange={(event) => setSearchValue(event.target.value)}
                      placeholder={t('workspaceApps.frappe.ui.searchPlaceholder', { name: activeBusinessLabel })}
                      className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-surface-100 dark:placeholder:text-surface-600"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRefreshKey((key) => key + 1)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
                    >
                      {t('workspaceApps.frappe.ui.refresh')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNotice(t('workspaceApps.frappe.notice.exportComing'))}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
                    >
                      {t('workspaceApps.frappe.ui.export')}
                    </button>
                  </div>
                </div>
                <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-600 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-400">{readOnlyNotice}</p>
              </section>
            ) : (
              <WorkspaceAppActionBar
                selectedCount={selectedRow ? 1 : 0}
                searchValue={searchValue}
                actions={actions}
                canCreate={canWriteThroughConnector}
                canEdit={canWriteThroughConnector}
                canChangeStatus={canWriteThroughConnector}
                onSearchChange={(value) => setSearchValue(value)}
                onCreate={() => {
                  if (!canWriteThroughConnector) return;
                  setSelectedRow(null);
                  setSelectedRowIndex(null);
                  setSelectedDeskUrl(null);
                  setActionState('idle');
                  setRecordMode('create');
                }}
                onEdit={() => {
                  if (!selectedRow || !canWriteThroughConnector) return;
                  setActionState('idle');
                  setRecordMode('edit');
                }}
                onChangeStatus={() => {
                  if (!selectedRow || !canWriteThroughConnector) return;
                  setActionState('idle');
                  setRecordMode('status');
                }}
                onExport={async () => {
                  setNotice(t('workspaceApps.frappe.notice.exportComing'));
                }}
              />
            )}

            <WorkspaceAppTableView
              view={table}
              activeSectionLabel={activeBusinessLabel}
              selectedRowIndex={selectedRowIndex}
              onSelectRow={handleSelectRow}
            />
          </main>

          <aside className="space-y-3">
            <WorkspaceAppRecordPanel
              mode={recordMode}
              fields={fields}
              selectedRow={selectedRow}
              sectionLabel={activeBusinessLabel}
              actionState={actionState}
              onModeChange={(mode) => {
                if (!canWriteThroughConnector && mode !== 'detail') return;
                setRecordMode(mode);
                setActionState('idle');
              }}
              onSubmit={handleSubmit}
              onClose={() => {
                setSelectedRow(null);
                setSelectedRowIndex(null);
                setSelectedDeskUrl(null);
                setRecordMode('detail');
                setActionState('idle');
              }}
            />
            {isRealReadOnly && (
              <section className="rounded-xl border border-slate-200 bg-white p-3 text-[12px] leading-5 text-slate-600 shadow-sm dark:border-surface-800 dark:bg-surface-900/70 dark:text-surface-400">
                <div className="font-bold text-slate-800 dark:text-surface-100">{t('workspaceApps.frappe.ui.originalHandling')}</div>
                <p className="mt-1">{t('workspaceApps.frappe.ui.originalDescription')}</p>
                <a href={openDeskUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-850">{t('workspaceApps.frappe.ui.openSelectedOriginal')}</a>
              </section>
            )}
          </aside>
        </div>

        <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
          <summary className="cursor-pointer text-sm font-bold text-slate-900 dark:text-surface-100">{t('workspaceApps.frappe.ui.adminSettings')}</summary>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-950/40">
              <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.connectionMethod')}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSourceMode('mock')}
                  className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold transition ${sourceMode === 'mock' ? activeSourceClass : inactiveSourceClass}`}
                >
                  Mock Frappe
                  <span className={`block text-[11px] ${sourceMode === 'mock' ? 'text-blue-100' : 'text-slate-500 dark:text-surface-500'}`}>{t('workspaceApps.frappe.ui.tryWithoutServer')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextDoctype = activeObject?.doctype ?? appliedDoctype;
                    setSourceMode('real-readonly');
                    setAppliedDoctype(nextDoctype);
                    setDoctypeInput(nextDoctype);
                    setActiveObjectId(frappeObjectIdFromDoctype(nextDoctype));
                  }}
                  className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold transition ${sourceMode === 'real-readonly' ? activeSourceClass : inactiveSourceClass}`}
                >
                  Real read-only
                  <span className={`block text-[11px] ${sourceMode === 'real-readonly' ? 'text-blue-100' : 'text-slate-500 dark:text-surface-500'}`}>{t('workspaceApps.frappe.ui.credentialRequired')}</span>
                </button>
              </div>
              {isRealReadOnly && (
                <form
                  className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const nextConnectionId = connectionId.trim();
                    const nextDoctype = doctypeInput.trim();
                    if (!nextConnectionId || !nextDoctype) {
                      setConnectionState('idle');
                      setNotice(t('workspaceApps.frappe.notice.connectionAndDoctypeRequired'));
                      return;
                    }
                    setAppliedConnectionId(nextConnectionId);
                    setAppliedDoctype(nextDoctype);
                    setActiveObjectId(frappeObjectIdFromDoctype(nextDoctype));
                    setReadiness(null);
                    setRefreshKey((key) => key + 1);
                  }}
                >
                  <label className="text-[12px] font-semibold text-slate-600 dark:text-surface-400">
                    Connection ID
                    <input
                      value={connectionId}
                      onChange={(event) => setConnectionId(event.target.value)}
                      placeholder="frappe-main"
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100"
                    />
                  </label>
                  <label className="text-[12px] font-semibold text-slate-600 dark:text-surface-400">
                    DocType
                    <input
                      value={doctypeInput}
                      onChange={(event) => setDoctypeInput(event.target.value)}
                      placeholder="Customer"
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100"
                    />
                  </label>
                  <button type="button" onClick={handleReadinessCheck} className="self-end rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100 dark:hover:bg-surface-850">{t('workspaceApps.frappe.ui.check')}</button>
                  <button type="submit" className="self-end rounded-lg bg-slate-900 px-3 py-2 text-sm font-bold text-white hover:bg-slate-800 dark:bg-surface-100 dark:text-surface-950 dark:hover:bg-surface-200">{t('workspaceApps.frappe.ui.load')}</button>
                </form>
              )}
              {isRealReadOnly && (
                <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-400">
                  {t('workspaceApps.frappe.ui.status')}: {connectionState === 'loading' ? t('workspaceApps.frappe.ui.checking') : connectionState === 'ready' ? t('workspaceApps.frappe.ui.connected', { host: connectionHostLabel, doctype: appliedDoctype }) : connectionState === 'error' ? t('workspaceApps.frappe.ui.connectionFailed') : t('workspaceApps.frappe.ui.waitingToLoad')}
                </div>
              )}
              {isRealReadOnly && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-surface-800 dark:bg-surface-900">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <label className="min-w-0 flex-1 text-[12px] font-semibold text-slate-600 dark:text-surface-400">
                      {t('workspaceApps.frappe.ui.searchStructure')}
                      <input
                        value={doctypeCandidateSearch}
                        onChange={(event) => setDoctypeCandidateSearch(event.target.value)}
                        placeholder="Customer, Invoice, Item..."
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100"
                      />
                    </label>
                    <button type="button" onClick={handleLoadDoctypeCandidates} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100 dark:hover:bg-surface-850">
                      {doctypeCandidateState === 'loading' ? t('workspaceApps.frappe.ui.reading') : t('workspaceApps.frappe.ui.readStructure')}
                    </button>
                  </div>
                  {doctypeCandidates.length > 0 && (
                    <div className="mt-3 grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">
                      {doctypeCandidates.slice(0, 24).map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => applyFrappeObject(candidate)}
                          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-[12px] text-slate-600 hover:bg-white dark:border-surface-800 dark:bg-surface-950/50 dark:text-surface-400 dark:hover:bg-surface-850"
                        >
                          <span className="block text-sm font-bold text-slate-900 dark:text-surface-100">{businessLabelForDoctype(candidate.doctype)}</span>
                          <span className="mt-0.5 block truncate">{t('workspaceApps.frappe.ui.templateName', { doctype: candidate.doctype })}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-600 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-400">
              <div className="font-bold text-slate-800 dark:text-surface-100">{t('workspaceApps.frappe.ui.setupGuide')}</div>
              <ol className="mt-2 list-decimal space-y-1 pl-4 leading-5">
                <li>{t('workspaceApps.frappe.ui.setup1')}</li>
                <li>{t('workspaceApps.frappe.ui.setup2')}</li>
                <li>{t('workspaceApps.frappe.ui.setup3Prefix')} <code className="font-mono">frappe</code>, {t('workspaceApps.frappe.ui.setup3Middle')} <code className="font-mono">frappe-main</code> {t('workspaceApps.frappe.ui.setup3Suffix')}</li>
                <li>{t('workspaceApps.frappe.ui.setup4')}</li>
              </ol>
              <pre className="mt-2 overflow-auto rounded-lg bg-white p-2 font-mono text-[11px] text-slate-700 dark:bg-surface-900 dark:text-surface-300">{`{
  "siteUrl": "https://your-frappe-site.example.com",
  "deskUrlBase": "https://your-frappe-desk.example.com",
  "apiKey": "<FRAPPE_API_KEY>",
  "apiSecret": "<FRAPPE_API_SECRET>"
}`}</pre>
              <p className="mt-2 leading-5 text-slate-500 dark:text-surface-500">{t('workspaceApps.frappe.ui.recommendation')}</p>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
