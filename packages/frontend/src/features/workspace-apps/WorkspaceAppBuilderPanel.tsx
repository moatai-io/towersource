import React from 'react';
import type { WorkspaceAppDraftRecord, WorkspaceAppPublishPreview, WorkspaceAppPublishResult } from './workspace-app-api';
import type { WorkspaceAppDefinition, WorkspaceAppBuilderDraftChange } from './workspace-app-definition';

const riskClass: Record<WorkspaceAppBuilderDraftChange['risk'], string> = {
  low: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
  medium: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200',
  high: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200',
};

export function WorkspaceAppBuilderPanel({
  builder,
  previewActive = false,
  draftSaveState = 'idle',
  savedDraftId,
  savedDrafts = [],
  publishPreviewState = 'idle',
  publishPreview,
  publishState = 'idle',
  publishResult,
  onTogglePreview,
  onSaveDraft,
  onPreviewPublish,
  onPublish,
}: {
  builder: WorkspaceAppDefinition['builder'];
  previewActive?: boolean;
  draftSaveState?: 'idle' | 'saving' | 'saved' | 'error';
  savedDraftId?: string | null;
  savedDrafts?: WorkspaceAppDraftRecord[];
  publishPreviewState?: 'idle' | 'loading' | 'ready' | 'error';
  publishPreview?: WorkspaceAppPublishPreview | null;
  publishState?: 'idle' | 'publishing' | 'published' | 'error';
  publishResult?: WorkspaceAppPublishResult | null;
  onTogglePreview?: () => void;
  onSaveDraft?: () => void;
  onPreviewPublish?: (draftId: string) => void;
  onPublish?: () => void;
}) {
  const draft = builder.draftPreview;
  return (
    <aside className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-900/70">
      <h2 className="text-[13px] font-bold text-slate-950 dark:text-surface-100">화면 구성 변경</h2>
      <p className="mt-1 text-[12px] leading-5 text-slate-500 dark:text-surface-500">업무 화면의 필드, 표, 메뉴를 바꾸는 관리자용 영역입니다. 일반 업무 입력은 상단 업무 버튼을 사용하세요.</p>
      <div className="mt-3 space-y-2">
        {builder.steps.slice(0, 3).map((step, index) => (
          <div key={step.id} className="flex gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-surface-800 dark:bg-surface-850/60">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700 dark:bg-primary-500/15 dark:text-primary-200">{index + 1}</div>
            <div className="text-[12px] text-slate-600 dark:text-surface-300">{step.label}</div>
          </div>
        ))}
      </div>

      {draft && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 dark:border-primary-500/20 dark:bg-primary-500/10">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-bold text-blue-950 dark:text-primary-100">변경안 미리보기</h3>
            <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[10px] font-bold text-blue-700 dark:border-primary-500/25 dark:bg-surface-950/50 dark:text-primary-200">
              아직 미반영
            </span>
          </div>
          {draft.summary && <p className="mt-2 text-[12px] leading-5 text-blue-800/80 dark:text-primary-100/80">{draft.summary}</p>}
          {onTogglePreview && (
            <button
              type="button"
              onClick={onTogglePreview}
              className="mt-3 w-full rounded-lg border border-blue-300 bg-white px-3 py-2 text-[12px] font-semibold text-blue-800 transition hover:bg-blue-100 dark:border-primary-500/25 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/20"
            >
              {previewActive ? '화면 미리보기 끄기' : '화면에 임시로 적용해보기'}
            </button>
          )}
          {onSaveDraft && (
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={draftSaveState === 'saving'}
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200 dark:hover:bg-surface-800"
            >
              {draftSaveState === 'saving' ? '변경안 저장 중…' : draftSaveState === 'saved' ? '변경안 저장됨' : '변경안 저장'}
            </button>
          )}
          {draftSaveState === 'saved' && savedDraftId && (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
              저장됨: <code>{savedDraftId.slice(0, 8)}</code>
            </div>
          )}
          {draftSaveState === 'error' && (
            <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-100">
              저장 실패 · 원본 화면은 변경되지 않았습니다.
            </div>
          )}
          <div className="mt-3 space-y-2">
            {draft.changes.map((change) => (
              <div key={change.path} className="rounded-lg border border-slate-200 bg-white p-2 dark:border-surface-800 dark:bg-surface-950/50">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <code className="truncate text-[11px] font-semibold text-slate-500 dark:text-surface-400">{change.path}</code>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${riskClass[change.risk]}`}>
                    {change.risk === 'low' ? '낮음' : change.risk === 'medium' ? '중간' : '높음'}
                  </span>
                </div>
                <div className="space-y-1 text-[12px] leading-5">
                  <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-500 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-500">
                    <span className="mr-1 font-bold text-slate-700 dark:text-surface-300">현재</span>{change.before || '—'}
                  </div>
                  <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
                    <span className="mr-1 font-bold">변경</span>{change.after || '—'}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {savedDrafts.length > 0 && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2 dark:border-surface-800 dark:bg-surface-950/50">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-surface-500">저장된 변경안</div>
              <div className="space-y-2">
                {savedDrafts.slice(0, 5).map((saved) => (
                  <div key={saved.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] leading-4 text-slate-600 dark:border-surface-800 dark:bg-surface-900/70 dark:text-surface-300">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-slate-800 dark:text-surface-200">{saved.draftPreview.title}</span>
                      <span className="shrink-0 rounded-full border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 dark:border-surface-700 dark:text-surface-500">저장됨</span>
                    </div>
                    <div className="mt-1 truncate text-slate-500 dark:text-surface-500">{new Date(saved.createdAt).toLocaleString()}</div>
                    {onPreviewPublish && (
                      <button
                        type="button"
                        onClick={() => onPreviewPublish(saved.id)}
                        className="mt-2 w-full rounded border border-blue-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-primary-500/20 dark:bg-primary-500/10 dark:text-primary-100 dark:hover:bg-primary-500/15"
                      >
                        반영 전 확인
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {publishPreviewState !== 'idle' && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
              {publishPreviewState === 'loading' && '반영 전 확인 중…'}
              {publishPreviewState === 'error' && '반영 전 확인 실패 · 원본 화면은 변경되지 않았습니다.'}
              {publishPreviewState === 'ready' && publishPreview && (
                <div className="space-y-1">
                  <div className="font-bold">반영 전 확인 완료</div>
                  <div>파일: <code>{publishPreview.sourcePath}</code></div>
                  <div>검증 코드: <code>{publishPreview.previewHash.slice(0, 12)}</code></div>
                </div>
              )}
            </div>
          )}
          {publishPreviewState === 'ready' && publishPreview && onPublish && (
            <button
              type="button"
              onClick={onPublish}
              disabled={publishState === 'publishing'}
              className="mt-3 w-full rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 text-[12px] font-bold text-amber-900 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-100 dark:hover:bg-amber-500/20"
            >
              {publishState === 'publishing' ? '반영 중…' : '확인하고 화면에 반영'}
            </button>
          )}
          {publishState === 'published' && publishResult && (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] leading-5 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
              반영 완료: <code>{publishResult.id.slice(0, 8)}</code>
            </div>
          )}
          {publishState === 'error' && (
            <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-100">
              반영 실패 · 원본이 바뀌었거나 승인이 유효하지 않습니다.
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
