import React from 'react';
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

const templatePlanPrompts = [
  '고객사에 사업자등록번호 필드 추가',
  '청구 승인 흐름을 초안 → 승인요청 → 승인으로 정리',
  '지난달 미수금 상위 고객 보고서 템플릿 만들기',
];

const defaultFrappeConnectionId = 'frappe-main';
const defaultFrappeDoctype = 'Customer';
const defaultFrappeBusinessDoctypes = ['Customer', 'Sales Invoice', 'Item', 'Supplier', 'Lead'];

const activeChoiceClass = 'border-blue-500 bg-blue-600 text-white shadow-sm dark:border-primary-400 dark:bg-primary-500';
const inactiveChoiceClass = 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-300 dark:hover:bg-surface-850';
const activeSourceClass = 'border-blue-500 bg-blue-600 text-white';
const inactiveSourceClass = 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200 dark:hover:bg-surface-850';

function businessLabelForDoctype(doctype: string): string {
  const normalized = doctype.trim().toLowerCase();
  if (normalized === 'customer') return '고객사';
  if (normalized === 'sales invoice') return '청구서';
  if (normalized === 'item') return '품목';
  if (normalized === 'supplier') return '공급처';
  if (normalized === 'lead') return '리드';
  return doctype.trim() || '업무';
}

function businessDescriptionForDoctype(doctype: string): string {
  const label = businessLabelForDoctype(doctype);
  if (label === '고객사') return 'Frappe Customer를 Tower 업무 화면에서 간단히 확인합니다.';
  if (label === '청구서') return 'Frappe Sales Invoice를 읽기 전용으로 확인합니다.';
  if (label === '품목') return 'Frappe Item 정보를 읽기 전용으로 확인합니다.';
  return 'Frappe 업무 객체를 Tower 업무 화면에서 간단히 확인합니다.';
}

function buildTemplatePlanPreview(prompt: string, doctype: string): TemplatePlanPreview {
  const businessLabel = businessLabelForDoctype(doctype);
  if (prompt.includes('사업자등록번호')) {
    return {
      kind: 'field',
      title: '필드 추가 계획',
      targetDoctype: doctype,
      summary: `${businessLabel} 템플릿에 사업자등록번호 필드를 추가하는 변경 계획입니다.`,
      steps: [
        `${doctype} DocType에 custom field business_registration_no 추가`,
        '표시 위치와 필수 여부를 관리자에게 확인',
        '기존 레코드에는 빈 값으로 시작하고 마이그레이션 영향 없음으로 기록',
      ],
      risks: ['필드명 중복 확인 필요', 'ERPNext 권한과 export/print format 반영 범위 확인 필요'],
      nextAction: 'Custom Field preview와 승인 후 적용 API/fixture 설계로 연결',
    };
  }
  if (prompt.includes('승인 흐름')) {
    return {
      kind: 'workflow',
      title: '워크플로 변경 계획',
      targetDoctype: doctype,
      summary: `${businessLabel} 템플릿의 상태 전환을 초안 → 승인요청 → 승인 흐름으로 정리하는 계획입니다.`,
      steps: [
        `${doctype}의 현재 status/workflow field 확인`,
        '허용 전환과 역할별 승인 권한 초안 생성',
        '기존 문서 상태값을 새 흐름에 매핑하는 preview 생성',
      ],
      risks: ['기존 진행 중 문서의 상태 매핑 필요', '승인 권한을 잘못 열면 실제 업무 통제가 약해질 수 있음'],
      nextAction: 'Workflow transition diff와 영향 레코드 샘플을 먼저 표시',
    };
  }
  return {
    kind: 'report',
    title: '보고서 템플릿 계획',
    targetDoctype: doctype,
    summary: `${businessLabel}와 관련된 미수금/최근 거래 데이터를 읽어 보고서 템플릿을 만드는 계획입니다.`,
    steps: [
      '관련 DocType 후보와 금액/일자 field 확인',
      '읽기 전용 query plan 생성',
      '결과 표, 요약, ERPNext deep link를 포함한 보고서 preview 생성',
    ],
    risks: ['미수금 계산은 Payment Entry/GL Entry 관계 확인 필요', '읽기 전용 query policy와 성능 제한 필요'],
    nextAction: 'read-only report query plan preview로 연결',
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
    { id: 'create', label: '신규 등록', type: 'create' },
    { id: 'update', label: '선택 수정', type: 'update' },
    { id: transition?.id ?? 'transition', label: transition?.label ?? '상태 변경', type: 'change-status', field: schema?.statusField },
    { id: 'export', label: sourceMode === 'mock' ? 'CSV 출력' : '출력', type: 'export' },
  ];
}

function schemaToTable(schema: BusinessObjectSchema | null, records: RecordList | null, sourceMode: FrappePilotSourceMode): WorkspaceAppTableViewDefinition {
  const fields = schema?.fields.filter((field) => field.kind !== 'child-table').slice(0, 5) ?? [];
  return {
    id: schema?.object.id ?? 'frappe-pilot',
    title: schema ? `${businessLabelForDoctype(schema.object.doctype)} 미리보기` : 'ERP 데이터 미리보기',
    subtitle: schema
      ? `${businessLabelForDoctype(schema.object.doctype)} 템플릿을 고치기 전에 원본 데이터를 ${sourceMode === 'mock' ? '체험용 샘플' : 'Frappe 읽기 전용 연결'}로 확인합니다.`
      : 'Frappe 같은 업무앱 backend를 연결하는 업무 화면입니다.',
    statusLabel: sourceMode === 'mock' ? '샘플 데이터' : '읽기 전용 ERP 연결',
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
      if (!cancelled) setNotice('Backend mock Frappe connector 객체를 불러오지 못했습니다.');
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
        setNotice('실제 Frappe 조회에는 project connection id와 DocType이 필요합니다. secret 값은 채팅에 입력하지 마세요.');
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
            setNotice('실제 Frappe connection에서 read-only 목록을 불러왔습니다. 쓰기 action은 아직 닫혀 있습니다.');
          }
        })
        .catch(() => {
          if (cancelled) return;
          setSchema(null);
          setRecords(null);
          setConnectionState('error');
        setNotice('실제 Frappe connection을 불러오지 못했습니다. Credential Vault project grant, connection id, DocType을 확인하세요.');
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
        setNotice('Backend mock Frappe connector 데이터를 불러오지 못했습니다.');
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
      setNotice('Connection ID를 입력한 뒤 점검하세요. secret 값은 Credential Vault에만 저장합니다.');
      return;
    }
    setConnectionState('loading');
    setReadiness(null);
    try {
      const nextReadiness = await fetchFrappeConnectionReadiness({ projectId, connectionId: nextConnectionId });
      setReadiness(nextReadiness);
      setConnectionState(nextReadiness?.ready ? 'ready' : 'error');
      setNotice(nextReadiness?.ready
        ? `Frappe connection 준비 완료: ${nextReadiness.siteHost}`
        : 'Frappe credential은 찾았지만 apiKey/apiSecret 구성이 완전하지 않습니다.');
    } catch {
      setConnectionState('error');
      setNotice('Frappe connection readiness를 확인하지 못했습니다. project grant와 connection id를 확인하세요.');
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
      setNotice('ERP 구조를 읽으려면 Connection ID가 필요합니다.');
      return;
    }
    setDoctypeCandidateState('loading');
    try {
      const nextCandidates = await fetchFrappeObjects({ projectId, connectionId: nextConnectionId, search: doctypeCandidateSearch, limit: 80 });
      setDoctypeCandidates(nextCandidates);
      setDoctypeCandidateState('ready');
      setNotice(nextCandidates.length ? `Frappe에서 템플릿 재료 ${nextCandidates.length}개를 읽었습니다.` : '조건에 맞는 Frappe 구조 후보가 없습니다.');
    } catch {
      setDoctypeCandidates([]);
      setDoctypeCandidateState('error');
      setNotice('Frappe ERP 구조를 읽지 못했습니다. 연결 권한과 DocType 읽기 권한을 확인하세요.');
    }
  }, [connectionId, doctypeCandidateSearch, projectId]);

  const handleTemplatePlanPrompt = React.useCallback((prompt: string) => {
    const targetDoctype = activeObject?.doctype ?? appliedDoctype;
    setTemplatePlanPreview(buildTemplatePlanPreview(prompt, targetDoctype));
    setNotice(`변경 계획 preview를 만들었습니다: ${prompt}`);
  }, [activeObject?.doctype, appliedDoctype]);

  const handleSubmit = React.useCallback(async (mode: WorkspaceAppRecordMode, values: Record<string, string>) => {
    if (!schema) return;
    if (isRealReadOnly) {
      setActionState('error');
      setNotice('실제 Frappe 연결의 쓰기 action은 아직 열지 않았습니다. 먼저 권한·감사·전이 정책을 설계해야 합니다.');
      return;
    }
    setActionState('saving');
    try {
      if (mode === 'create') {
        await runMockFrappeAction({ projectId, objectId: activeObjectId, actionId: 'create', values });
        setNotice('Backend mock connector에 신규 항목을 저장했습니다. 실제 연결 시 Frappe REST API로 전송됩니다.');
      } else if (mode === 'status') {
        const transition = schema.transitions[0];
        if (!selectedRow?.id || !transition) throw new Error('transition unavailable');
        await runMockFrappeAction({ projectId, objectId: activeObjectId, actionId: `transition:${transition.id}`, recordId: selectedRow.id, values: {} });
        setNotice(`${transition.label} 처리를 완료했습니다.`);
      } else {
        if (!selectedRow?.id) throw new Error('record unavailable');
        await runMockFrappeAction({ projectId, objectId: activeObjectId, actionId: 'update', recordId: selectedRow.id, values });
        setNotice('선택 항목을 저장했습니다.');
      }
      setActionState('saved');
      setRecordMode('detail');
      setSelectedRow(null);
      setSelectedRowIndex(null);
      setRefreshKey((key) => key + 1);
    } catch {
      setActionState('error');
      setNotice('저장하지 못했습니다. connector action과 입력값을 확인하세요.');
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
      .catch(() => setNotice('선택 항목 상세를 불러오지 못했습니다. 목록 값만 표시합니다.'));
  }, [appliedConnectionId, appliedDoctype, isRealReadOnly, projectId]);

  const openDeskUrl = selectedDeskUrl ?? schema?.object.deskUrl ?? activeObject?.deskUrl ?? 'https://frappe.example.test/app';
  const activeBusinessLabel = activeObject ? businessLabelForDoctype(activeObject.doctype) : businessLabelForDoctype(appliedDoctype);
  const objectCountLabel = records ? `${records.rows.length.toLocaleString()}건` : connectionState === 'loading' ? '불러오는 중' : '대기 중';
  const connectionHostLabel = readiness?.deskHost ?? readiness?.siteHost ?? (isRealReadOnly ? appliedConnectionId : '샘플 데이터');
  const readOnlyNotice = isRealReadOnly
    ? '이 연결은 현재 읽기 전용입니다. 수정이 필요하면 Frappe 원본에서 처리하거나, 쓰기 정책을 먼저 설계해야 합니다.'
    : '샘플 데이터에서는 신규 등록과 선택 수정을 체험할 수 있습니다.';

  return (
    <div className="h-full overflow-auto bg-slate-100 text-slate-950 dark:bg-surface-950 dark:text-surface-100">
      <div className="mx-auto flex min-h-full max-w-[96rem] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-bold text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100">
                업무 앱
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500 dark:bg-surface-950/50 dark:text-surface-400">DIY ERP Connector</span>
              </div>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950 dark:text-surface-50">ERP 템플릿을 읽고 맞춤화합니다</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-surface-400">
                Tower는 ERPNext 화면을 복제하지 않고, Frappe 구조를 읽어 고객 업무에 맞는 필드·화면·보고서·워크플로 변경 계획을 만드는 작업대입니다.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[28rem]">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-surface-500">선택한 템플릿</div>
                <div className="mt-1 text-sm font-bold text-slate-900 dark:text-surface-100">{activeBusinessLabel}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-surface-500">연결 상태</div>
                <div className="mt-1 truncate text-sm font-bold text-slate-900 dark:text-surface-100">{connectionState === 'loading' ? '조회 중' : isRealReadOnly ? '읽기 전용' : '샘플'}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-surface-500">미리보기</div>
                <div className="mt-1 text-sm font-bold text-slate-900 dark:text-surface-100">{objectCountLabel}</div>
              </div>
            </div>
          </div>
          {notice && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">{notice}</p>}
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-surface-100">ERP 구조 지도</h2>
              <p className="mt-1 text-[12px] text-slate-500 dark:text-surface-500">Frappe 템플릿 재료를 업무 언어로 고르고, 필요한 맞춤화는 아래 작업창에서 계획합니다.</p>
            </div>
            <a
              href={openDeskUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
            >
              ERPNext/Frappe 원본 열기
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
                  <div className={`mt-2 text-[11px] ${isActive ? 'text-blue-100 dark:text-primary-100' : 'text-slate-400 dark:text-surface-600'}`}>{sourceMode === 'mock' ? '샘플 템플릿' : 'Frappe 템플릿'}</div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-surface-100">템플릿 작업창</h2>
                <p className="mt-1 max-w-2xl text-[13px] leading-5 text-slate-600 dark:text-surface-400">
                  여기서 목표는 ERPNext보다 나은 목록 화면을 만드는 것이 아니라, 선택한 Frappe 템플릿을 고객 업무에 맞게 바꾸는 변경 계획을 만드는 것입니다.
                </p>
              </div>
              <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold text-slate-500 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-400">Preview only</span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {templatePlanPrompts.map((prompt) => (
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
                    <div className="mt-1 text-[11px] text-slate-500 dark:text-surface-500">대상: {templatePlanPreview.targetDoctype}</div>
                  </div>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">승인 전</span>
                </div>
                <p className="mt-3 text-slate-700 dark:text-surface-300">{templatePlanPreview.summary}</p>
                <div className="mt-3 font-bold text-slate-800 dark:text-surface-100">예상 변경</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {templatePlanPreview.steps.map((step) => <li key={step}>{step}</li>)}
                </ul>
                <div className="mt-3 font-bold text-slate-800 dark:text-surface-100">확인할 위험</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {templatePlanPreview.risks.map((risk) => <li key={risk}>{risk}</li>)}
                </ul>
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-surface-800 dark:bg-surface-950/40">다음: {templatePlanPreview.nextAction}</div>
              </div>
            ) : (
              <div>
                <div className="font-bold text-slate-900 dark:text-surface-100">적용 전 Preview 원칙</div>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>읽기 분석은 먼저 표와 근거를 보여줍니다.</li>
                  <li>필드·화면·워크플로 변경은 diff와 위험을 보여준 뒤 승인합니다.</li>
                  <li>복잡한 원본 편집은 ERPNext/Frappe Desk로 deep link합니다.</li>
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
                    <span className="shrink-0 text-[12px] font-bold text-slate-500 dark:text-surface-500">검색</span>
                    <input
                      value={searchValue}
                      onChange={(event) => setSearchValue(event.target.value)}
                      placeholder={`${activeBusinessLabel}, 담당자, 상태 검색`}
                      className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-surface-100 dark:placeholder:text-surface-600"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRefreshKey((key) => key + 1)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
                    >
                      새로고침
                    </button>
                    <button
                      type="button"
                      onClick={() => setNotice('CSV 출력은 다음 slice에서 backend export receipt와 연결합니다. 현재 목록은 connector API로 조회 중입니다.')}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
                    >
                      출력
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
                  setNotice('CSV 출력은 다음 slice에서 backend export receipt와 연결합니다. 현재 목록은 connector API로 조회 중입니다.');
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
                <div className="font-bold text-slate-800 dark:text-surface-100">원본 처리 안내</div>
                <p className="mt-1">ERPNext/Frappe Desk는 여전히 정식 편집 화면입니다. Tower는 변경 계획과 preview를 만든 뒤 승인된 작업만 실행하는 방향으로 확장합니다.</p>
                <a href={openDeskUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-850">선택 항목 원본 열기</a>
              </section>
            )}
          </aside>
        </div>

        <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
          <summary className="cursor-pointer text-sm font-bold text-slate-900 dark:text-surface-100">관리자 설정 · ERP 연결</summary>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-950/40">
              <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-surface-500">연결 방식</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSourceMode('mock')}
                  className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold transition ${sourceMode === 'mock' ? activeSourceClass : inactiveSourceClass}`}
                >
                  Mock Frappe
                  <span className={`block text-[11px] ${sourceMode === 'mock' ? 'text-blue-100' : 'text-slate-500 dark:text-surface-500'}`}>서버 없이 체험</span>
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
                  <span className={`block text-[11px] ${sourceMode === 'real-readonly' ? 'text-blue-100' : 'text-slate-500 dark:text-surface-500'}`}>Credential Vault 필요</span>
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
                      setNotice('Connection ID와 DocType을 모두 입력한 뒤 조회하세요. secret 값은 Credential Vault에만 저장합니다.');
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
                  <button type="button" onClick={handleReadinessCheck} className="self-end rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100 dark:hover:bg-surface-850">점검</button>
                  <button type="submit" className="self-end rounded-lg bg-slate-900 px-3 py-2 text-sm font-bold text-white hover:bg-slate-800 dark:bg-surface-100 dark:text-surface-950 dark:hover:bg-surface-200">조회</button>
                </form>
              )}
              {isRealReadOnly && (
                <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-400">
                  상태: {connectionState === 'loading' ? '점검/조회 중' : connectionState === 'ready' ? `연결됨 · ${connectionHostLabel} · ${appliedDoctype}` : connectionState === 'error' ? '연결 실패' : '조회 대기'}
                </div>
              )}
              {isRealReadOnly && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-surface-800 dark:bg-surface-900">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <label className="min-w-0 flex-1 text-[12px] font-semibold text-slate-600 dark:text-surface-400">
                      ERP 구조 검색
                      <input
                        value={doctypeCandidateSearch}
                        onChange={(event) => setDoctypeCandidateSearch(event.target.value)}
                        placeholder="Customer, Invoice, Item..."
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100"
                      />
                    </label>
                    <button type="button" onClick={handleLoadDoctypeCandidates} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100 dark:hover:bg-surface-850">
                      {doctypeCandidateState === 'loading' ? '읽는 중' : 'ERP 구조 읽기'}
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
                          <span className="mt-0.5 block truncate">{candidate.doctype} 템플릿</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-600 dark:border-surface-800 dark:bg-surface-950/40 dark:text-surface-400">
              <div className="font-bold text-slate-800 dark:text-surface-100">Frappe 연결 준비 방법</div>
              <ol className="mt-2 list-decimal space-y-1 pl-4 leading-5">
                <li>Frappe/ERPNext에서 read-only 전용 사용자에게 필요한 DocType 읽기 권한을 부여합니다.</li>
                <li>그 사용자 설정에서 API key와 API secret을 발급합니다.</li>
                <li>Tower Credential Vault에 provider <code className="font-mono">frappe</code>, credential id <code className="font-mono">frappe-main</code> 같은 project credential로 저장합니다.</li>
                <li>기본 업무 화면에는 secret 값을 붙여넣지 말고, 관리자 설정에서 Connection ID와 DocType만 점검합니다.</li>
              </ol>
              <pre className="mt-2 overflow-auto rounded-lg bg-white p-2 font-mono text-[11px] text-slate-700 dark:bg-surface-900 dark:text-surface-300">{`{
  "siteUrl": "https://your-frappe-site.example.com",
  "deskUrlBase": "https://your-frappe-desk.example.com",
  "apiKey": "<FRAPPE_API_KEY>",
  "apiSecret": "<FRAPPE_API_SECRET>"
}`}</pre>
              <p className="mt-2 leading-5 text-slate-500 dark:text-surface-500">권장: 처음에는 read-only 사용자와 credential을 쓰고, 쓰기 권한은 별도 connection과 감사 정책으로 분리합니다.</p>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
