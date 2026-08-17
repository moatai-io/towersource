import React from 'react';
import type { WorkspaceAppField } from './workspace-app-definition';

export type WorkspaceAppRecordMode = 'detail' | 'create' | 'edit' | 'status';

function fieldKey(field: WorkspaceAppField) {
  return field.sourceColumn ?? field.id;
}

function getInitialValue(field: WorkspaceAppField, row: Record<string, string> | null) {
  if (row) return row[fieldKey(field)] ?? '';
  if (field.type === 'status' || field.type === 'select') return field.options?.[0] ?? '상담중';
  return '';
}

export function WorkspaceAppRecordPanel({
  mode,
  fields,
  selectedRow,
  sectionLabel,
  actionState = 'idle',
  onModeChange,
  onClose,
  onSubmit,
}: {
  mode: WorkspaceAppRecordMode;
  fields: WorkspaceAppField[];
  selectedRow: Record<string, string> | null;
  sectionLabel?: string;
  actionState?: 'idle' | 'saving' | 'saved' | 'error';
  onModeChange: (mode: WorkspaceAppRecordMode) => void;
  onClose: () => void;
  onSubmit?: (mode: WorkspaceAppRecordMode, values: Record<string, string>) => void;
}) {
  const formValues = React.useMemo(
    () => Object.fromEntries(fields.map((field) => [field.id, getInitialValue(field, selectedRow)])),
    [fields, selectedRow],
  );
  const [draft, setDraft] = React.useState<Record<string, string>>(formValues);

  React.useEffect(() => {
    setDraft(formValues);
  }, [formValues]);

  const title = mode === 'create'
    ? '신규 등록'
    : mode === 'edit'
      ? '선택 수정'
      : mode === 'status'
        ? '상태 변경'
        : '상세 보기';
  const isFormMode = mode === 'create' || mode === 'edit' || mode === 'status';
  const visibleFields = mode === 'status'
    ? fields.filter((field) => field.type === 'status' || field.type === 'select')
    : fields;

  return (
    <aside className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-surface-800 dark:bg-surface-850/70">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-surface-500">{sectionLabel || '업무 항목'}</div>
            <h2 className="mt-0.5 text-[16px] font-bold text-slate-950 dark:text-surface-50">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-500 hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-400 dark:hover:bg-surface-850"
          >
            닫기
          </button>
        </div>
      </div>

      <div className="p-4">
        {!selectedRow && mode === 'detail' ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-[13px] leading-6 text-slate-600 dark:border-surface-700 dark:bg-surface-950/40 dark:text-surface-400">
            왼쪽 표에서 항목을 선택하면 상세 정보가 여기에 표시됩니다. 새 항목은 상단의 <span className="font-bold text-slate-800 dark:text-surface-200">신규 등록</span>을 누르세요.
          </div>
        ) : isFormMode ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] leading-5 text-blue-800 dark:border-primary-500/20 dark:bg-primary-500/10 dark:text-primary-100">
              저장은 화면 정의에 등록된 업무 action만 실행합니다. 허용되지 않은 필드나 상태값은 저장되지 않습니다.
            </div>
            {visibleFields.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-[12px] text-slate-500 dark:border-surface-700 dark:bg-surface-950/40 dark:text-surface-500">
                입력 필드가 아직 정의되지 않았습니다. 관리자 설정에서 fields를 추가하세요.
              </div>
            ) : visibleFields.map((field) => (
              <label key={field.id} className="block">
                <span className="mb-1 block text-[12px] font-bold text-slate-600 dark:text-surface-300">{field.label}{field.required ? ' *' : ''}</span>
                {field.type === 'status' || field.type === 'select' ? (
                  <select
                    value={draft[field.id] ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value }))}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-400 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100"
                  >
                    {(field.options?.length ? field.options : ['상담중', '제안', '계약', '보류', '준비 중']).map((option) => <option key={option}>{option}</option>)}
                  </select>
                ) : (
                  <input
                    value={draft[field.id] ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value }))}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:placeholder:text-surface-600"
                    placeholder={`${field.label} 입력`}
                  />
                )}
              </label>
            ))}
            {actionState === 'error' && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-100">
                저장 실패 · 입력값과 권한을 확인하세요.
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => onSubmit?.(mode, draft)}
                disabled={actionState === 'saving'}
                className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-primary-500 dark:hover:bg-primary-400"
              >
                {actionState === 'saving' ? '저장 중…' : actionState === 'saved' ? '저장됨' : '저장'}
              </button>
              <button
                type="button"
                onClick={() => onModeChange(selectedRow ? 'detail' : 'create')}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {fields.map((field) => (
              <div key={field.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-surface-800 dark:bg-surface-950/40">
                <div className="text-[11px] font-bold text-slate-500 dark:text-surface-500">{field.label}</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-surface-100">{selectedRow?.[fieldKey(field)] || '—'}</div>
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => onModeChange('edit')}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
              >
                수정
              </button>
              <button
                type="button"
                onClick={() => onModeChange('status')}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
              >
                상태 변경
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
