import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OfficePreviewToolbar } from './OfficePreviewToolbar';

/**
 * DOCX Preview via server-side LibreOffice PDF conversion.
 * Renders Word documents with near-perfect layout including Korean text.
 */
export function DocxPreview({ filePath, cacheKey }: { filePath: string; cacheKey?: string }) {
  const { t } = useTranslation('files');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const token = localStorage.getItem('token') || '';
  const pdfUrl = `/api/files/docx-pdf?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}${cacheKey ? `&v=${encodeURIComponent(cacheKey)}` : ''}`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <OfficePreviewToolbar filePath={filePath} previewUrl={pdfUrl} />
      {loading && !error && (
        <div className="flex items-center justify-center py-8 text-gray-400 text-base">
          <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {t('convertingDocument')}
        </div>
      )}
      {error && (
        <div className="flex items-center justify-center py-8 text-red-400 text-base">
          {error}
        </div>
      )}
      <iframe
        src={pdfUrl}
        className="flex-1 border-0 bg-white"
        style={{ display: error ? 'none' : 'block' }}
        title="docx-preview"
        onLoad={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setError(t('documentPreviewFailed'));
        }}
      />
    </div>
  );
}
