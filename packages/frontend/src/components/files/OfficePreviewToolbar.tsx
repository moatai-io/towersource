import { towerHttpUrl } from '../../features/client-connection/connection';
import { useTranslation } from 'react-i18next';

interface OfficePreviewToolbarProps {
  filePath: string;
  previewLabel?: string;
  previewUrl?: string;
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() || 'document';
}

/** Shared Office viewer toolbar: PDF preview context + original download. */
export function OfficePreviewToolbar({
  filePath,
  previewLabel,
  previewUrl,
}: OfficePreviewToolbarProps) {
  const { t } = useTranslation('files');
  const token = localStorage.getItem('token') || '';
  const fileName = fileNameOf(filePath);
  const downloadUrl = towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(filePath)}&download=1&token=${encodeURIComponent(token)}`);

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-700 bg-surface-900/95 shrink-0">
      <div className="rounded-md bg-surface-800 px-2.5 py-1 text-sm text-gray-200 whitespace-nowrap">
        {previewLabel || t('pdfPreview')}
      </div>
      <div className="flex-1 min-w-0 text-xs text-gray-500 truncate" title={filePath}>
        {fileName}
      </div>
      {previewUrl && (
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm px-3 py-1 rounded border border-surface-600 bg-surface-800 hover:bg-surface-700 text-gray-200 transition-colors whitespace-nowrap"
          title={t('openInBrowserPdfViewer')}
        >
          {t('openPdfInNewTab')}
        </a>
      )}
      <a
        href={downloadUrl}
        download={fileName}
        className="text-sm px-3 py-1 rounded bg-primary-600 hover:bg-primary-700 text-white transition-colors whitespace-nowrap"
        title={t('downloadOriginalFile')}
      >
        {t('downloadOriginal')}
      </a>
    </div>
  );
}
