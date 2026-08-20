import { useTranslation } from 'react-i18next';
import { formatBytes } from '../../utils/file-optimizer';
import type { UploadProgressSnapshot } from '../../utils/upload-with-progress';

export function UploadProgressChip({ progress, className = '' }: { progress: UploadProgressSnapshot; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div
      className={`relative inline-flex h-9 max-w-[220px] items-center gap-2 overflow-hidden rounded-lg border border-primary-500/30 bg-primary-500/10 px-2.5 text-[12px] ${className}`}
      role="status"
      aria-live="polite"
      aria-label={t('uploadProgress.label', { percent: progress.percent })}
      title={`${progress.currentFileName} · ${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`}
    >
      <svg className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M12 16V5m0 0L8.5 8.5M12 5l3.5 3.5M6.5 19h11" />
      </svg>
      <span className="min-w-0 flex-1 truncate font-medium text-surface-700 dark:text-surface-200">
        {progress.phase === 'processing' ? t('uploadProgress.saving') : progress.currentFileName}
      </span>
      <span className="shrink-0 font-bold tabular-nums text-primary-700 dark:text-primary-200">{progress.percent}%</span>
      <div
        className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-300 dark:bg-surface-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <div className="h-full bg-primary-600 transition-[width] duration-150 dark:bg-primary-400" style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}
