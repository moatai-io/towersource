import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatBytes, useUploadStore, type UploadItem } from '../../stores/upload-store';

function statusLabel(status: UploadItem['status'], t: TFunction<'common'>): string {
  switch (status) {
    case 'queued': return t('uploadQueue.status.queued', { defaultValue: '대기 중' });
    case 'uploading': return t('uploadQueue.status.uploading', { defaultValue: '업로드 중' });
    case 'paused': return t('uploadQueue.status.paused', { defaultValue: '일시 정지' });
    case 'completing': return t('uploadQueue.status.completing', { defaultValue: '저장 마무리 중' });
    case 'completed': return t('uploadQueue.status.completed', { defaultValue: '완료' });
    case 'failed': return t('uploadQueue.status.failed', { defaultValue: '실패' });
    case 'cancelled': return t('uploadQueue.status.cancelled', { defaultValue: '취소됨' });
  }
}

function UploadRow({ upload }: { upload: UploadItem }) {
  const { t } = useTranslation('common');
  const requestPause = useUploadStore((s) => s.requestPause);
  const requestResume = useUploadStore((s) => s.requestResume);
  const requestCancel = useUploadStore((s) => s.requestCancel);
  const removeUpload = useUploadStore((s) => s.removeUpload);
  const percent = upload.totalBytes > 0 ? Math.min(100, Math.round((upload.uploadedBytes / upload.totalBytes) * 100)) : 0;
  const terminal = ['completed', 'failed', 'cancelled'].includes(upload.status);

  return (
    <div className="rounded-xl border border-surface-700/70 bg-surface-900/95 p-3 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-base font-medium text-surface-100">{upload.name}</div>
            <span className="shrink-0 rounded-full border border-surface-700 px-2 py-0.5 text-[12px] text-surface-400">{statusLabel(upload.status, t)}</span>
          </div>
          <div className="mt-1 truncate text-[13px] text-surface-500">{upload.targetDir}</div>
        </div>
        {terminal && (
          <button className="text-surface-500 hover:text-surface-200" onClick={() => removeUpload(upload.id)} aria-label={t('uploadQueue.dismiss', { defaultValue: '업로드 항목 닫기' })}>×</button>
        )}
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-800">
        <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[13px] text-surface-400">
        <span>{formatBytes(upload.uploadedBytes)} / {formatBytes(upload.totalBytes)} · {percent}%</span>
        <span>{t('uploadQueue.fileProgress', { defaultValue: '{{completed}}/{{total}}개 파일', completed: upload.completedFiles, total: upload.totalFiles })}</span>
      </div>
      {upload.currentFile && upload.status === 'uploading' && (
        <div className="mt-1 truncate text-[13px] text-surface-500">{t('uploadQueue.currentFile', { defaultValue: '현재 파일: {{file}}', file: upload.currentFile })}</div>
      )}
      {upload.error && <div className="mt-2 text-[13px] text-red-300">{upload.error}</div>}

      <div className="mt-3 flex justify-end gap-2">
        {upload.status === 'uploading' && (
          <button className="rounded-lg border border-surface-700 px-2 py-1 text-[13px] text-surface-300 hover:bg-surface-800" onClick={() => requestPause(upload.id)}>{t('uploadQueue.pause', { defaultValue: '일시 정지' })}</button>
        )}
        {upload.status === 'paused' && (
          <button className="rounded-lg border border-primary-500/60 px-2 py-1 text-[13px] text-primary-300 hover:bg-primary-500/10" onClick={() => requestResume(upload.id)}>{t('uploadQueue.resume', { defaultValue: '다시 시작' })}</button>
        )}
        {!terminal && (
          <button className="rounded-lg border border-red-500/40 px-2 py-1 text-[13px] text-red-200 hover:bg-red-500/10" onClick={() => requestCancel(upload.id)}>{t('cancel')}</button>
        )}

      </div>
    </div>
  );
}

export function UploadPanel() {
  const { t } = useTranslation('common');
  const uploads = useUploadStore((s) => s.uploads);
  const clearCompleted = useUploadStore((s) => s.clearCompleted);
  const visible = useMemo(() => uploads.slice(-3).reverse(), [uploads]);
  if (visible.length === 0) return null;

  const completedCount = uploads.filter((u) => ['completed', 'cancelled'].includes(u.status)).length;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] w-[min(420px,calc(100vw-2rem))] space-y-2">
      <div className="pointer-events-auto flex justify-end">
        {completedCount > 0 && (
          <button className="rounded-full border border-surface-700 bg-surface-900/95 px-3 py-1 text-[13px] text-surface-400 hover:text-surface-100" onClick={clearCompleted}>
            {t('uploadQueue.clearCompleted', { defaultValue: '완료된 항목 지우기' })}
          </button>
        )}
      </div>
      <div className="pointer-events-auto space-y-2">
        {visible.map((u) => <UploadRow key={u.id} upload={u} />)}
      </div>
    </div>
  );
}
