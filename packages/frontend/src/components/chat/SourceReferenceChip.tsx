import { useTranslation } from 'react-i18next';
import type { ComposerSourceReference } from '../files/source-inspector/sourceReference';

interface SourceReferenceChipProps {
  reference: ComposerSourceReference;
  onRemove?: () => void;
  state?: 'attached' | 'sent';
}

export function SourceReferenceChip({ reference, onRemove, state = 'attached' }: SourceReferenceChipProps) {
  const { t } = useTranslation('chat');
  const label = `<${reference.tagName}> · ${reference.path}:L${reference.lineStart}–L${reference.lineEnd}`;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-primary-500/35 bg-primary-900/25 px-2.5 py-1 font-mono text-[13px] font-medium text-primary-200"
      title={`${label}\n${t('sourceReference.exactDescription', { defaultValue: '정적 HTML의 정확한 소스 참조' })}`}
    >
      <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8.5 9L5.5 12l3 3M15.5 9l3 3-3 3M13.5 6l-3 12" />
      </svg>
      <span className="truncate">{label}</span>
      <span className="shrink-0 rounded bg-primary-500/15 px-1 py-0.5 font-sans text-[10px] uppercase tracking-wide text-primary-200">
        {state === 'sent' ? t('sourceReference.sent', { defaultValue: '전송됨' }) : t('sourceReference.exact', { defaultValue: '소스 참조' })}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 shrink-0 opacity-60 transition-opacity hover:opacity-100"
          title={t('sourceReference.remove', { defaultValue: '소스 참조 제거' })}
          aria-label={t('sourceReference.remove', { defaultValue: '소스 참조 제거' })}
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}
