// Owns: URL preview creation dialog. Public API: OpenUrlPreviewDialog.
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizePreviewUrl } from './url-preview';

interface OpenUrlPreviewDialogProps {
  onClose: () => void;
  onOpen: (url: string) => void;
}

/** Ask for and validate one URL before creating a Viewer resource tab. */
export function OpenUrlPreviewDialog({ onClose, onOpen }: OpenUrlPreviewDialogProps) {
  const { t } = useTranslation('layout');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      onOpen(normalizePreviewUrl(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('urlPreviewInvalid'));
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <form onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-lg rounded-2xl border border-surface-700 bg-surface-950 p-5 shadow-2xl">
        <h2 className="text-lg font-semibold text-surface-100">{t('openUrlPreview')}</h2>
        <p className="mt-1 text-sm leading-6 text-surface-500">{t('urlPreviewDescription')}</p>
        <label className="mt-4 block text-xs font-semibold text-surface-300" htmlFor="viewer-preview-url">{t('previewUrl')}</label>
        <input
          id="viewer-preview-url"
          autoFocus
          value={value}
          onChange={(event) => { setValue(event.target.value); setError(''); }}
          placeholder="http://localhost:32354/path"
          className="mt-2 h-10 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 font-mono text-sm text-surface-100 outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
        />
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-surface-700 px-3 py-2 text-sm font-medium text-surface-300 hover:bg-surface-900">{t('common:cancel')}</button>
          <button type="submit" className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-500">{t('openInViewer')}</button>
        </div>
      </form>
    </div>
  );
}
