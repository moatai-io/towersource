import type { Attachment } from '../../stores/chat-store';
import { fileServeUrl } from '../../utils/file-path-links';
import { useSessionStore } from '../../stores/session-store';
import { useTranslation } from 'react-i18next';

interface AttachmentChipProps {
  attachment: Attachment;
  onRemove: (id: string) => void;
}

/* ── Helpers ── */

function stripTimestampPrefix(name: string): string {
  return name.replace(/^\d{10,}-/, '');
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FileGlyphKind = 'document' | 'sheet' | 'archive' | 'audio' | 'video' | 'image' | 'folder';

function getFileGlyphKind(filename: string): FileGlyphKind {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (['xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(ext)) return 'sheet';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'archive';
  if (['mp3', 'wav', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return 'video';
  if (['svg'].includes(ext)) return 'image';
  if (['pdf', 'doc', 'docx', 'hwp', 'hwpx'].includes(ext)) return 'document';
  return 'folder';
}

function FileGlyph({ kind = 'document', className = '' }: { kind?: FileGlyphKind; className?: string }) {
  const accentPath = kind === 'sheet'
    ? 'M8 12h8M8 16h8M8 8h4'
    : kind === 'archive'
      ? 'M9 8h6M9 12h6M10 16h4'
      : kind === 'audio'
        ? 'M9 15V9l6-2v6M9 15a2 2 0 11-2-2 2 2 0 012 2zm6-2a2 2 0 11-2-2 2 2 0 012 2z'
        : kind === 'video'
          ? 'M8 9h6v6H8zM14 11l3-2v6l-3-2'
          : kind === 'image'
            ? 'M8 15l2.5-3 2 2.4L14 13l2 2M9 9h.01'
            : kind === 'folder'
              ? 'M4.75 8.75h5l1.35 1.5h8.15v6.5a1.5 1.5 0 01-1.5 1.5H6.25a1.5 1.5 0 01-1.5-1.5v-8z'
              : 'M8 12h8M8 16h5';

  if (kind === 'folder') {
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={accentPath} />
      </svg>
    );
  }

  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7.75 3.75h6.5L18.25 8v12.25H7.75z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14 3.75V8h4.25" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={accentPath} />
    </svg>
  );
}

/* ── Styles for non-file types ── */

const chipStyles: Record<string, { icon: string; bg: string; text: string; border: string }> = {
  prompt: { icon: '⚡', bg: 'tone-bg-soft', text: 'tone-warning tone-text', border: 'tone-warning tone-border' },
  command: { icon: '/', bg: 'bg-primary-900/30', text: 'text-primary-300', border: 'border-primary-500/30' },
  upload: { icon: 'upload', bg: 'tone-bg-soft', text: 'tone-success tone-text', border: 'tone-success tone-border' },
};

/* ── Remove button ── */

function RemoveBtn({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <button
      onClick={onClick}
      className="shrink-0 ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
      title={t('remove')}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}

/* ── Main component ── */

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const { t } = useTranslation('chat');
  const isFile = attachment.type === 'file';
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionPreviewUrl = attachment.sessionAttachmentId && activeSessionId
    ? `/api/session-attachments/${encodeURIComponent(activeSessionId)}/${attachment.sessionAttachmentId}/content`
    : null;
  const isImage = isFile && attachment.mimeType?.startsWith('image/');

  // ── Image thumbnail ──
  if (isFile && isImage) {
    return (
      <span
        className="file-chip inline-flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg text-[14px] font-medium border max-w-[220px] group"
        data-path={attachment.content}
      >
        <img
          src={sessionPreviewUrl || fileServeUrl(attachment.tempPath || attachment.content)}
          alt={attachment.label}
          className="h-12 max-w-[80px] rounded object-cover"
          loading="lazy"
        />
        <span className="flex flex-col min-w-0 gap-0.5">
          <span className="truncate text-[13px]">{stripTimestampPrefix(attachment.label)}</span>
          {attachment.size && (
            <span className="file-chip-meta text-[12px]">{formatFileSize(attachment.size)}</span>
          )}
          {attachment.sessionAttachmentId && <span className="text-[10px] text-primary-300">{t('sessionOnlySevenDays')}</span>}
        </span>
        <RemoveBtn onClick={() => onRemove(attachment.id)} />
      </span>
    );
  }

  // ── Non-image file ──
  if (isFile) {
    const glyphKind = getFileGlyphKind(attachment.label);
    const sizeStr = formatFileSize(attachment.size);
    return (
      <span
        className="file-chip inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[14px] font-medium border max-w-[220px] group"
        data-path={attachment.content}
      >
        <FileGlyph kind={glyphKind} className="shrink-0 w-4 h-4 opacity-80" />
        <span className="truncate">{stripTimestampPrefix(attachment.label)}</span>
        {sizeStr && <span className="file-chip-meta shrink-0 text-[12px]">{sizeStr}</span>}
        {attachment.sessionAttachmentId && <span className="shrink-0 text-[10px] text-primary-300">{t('sessionOnly')}</span>}
        <RemoveBtn onClick={() => onRemove(attachment.id)} />
      </span>
    );
  }

  // ── Default: prompt / command / upload ──
  const style = chipStyles[attachment.type] || chipStyles.upload;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[14px] font-medium border ${style.bg} ${style.text} ${style.border} max-w-[200px] group`}
    >
      {style.icon === 'upload' ? (
        <svg className="shrink-0 w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M12 5v10m0 0l-3.5-3.5M12 15l3.5-3.5M6.5 19h11" />
        </svg>
      ) : (
        <span className="shrink-0 text-[13px] leading-none">{style.icon}</span>
      )}
      <span className="truncate">{attachment.label}</span>
      <RemoveBtn onClick={() => onRemove(attachment.id)} />
    </span>
  );
}
