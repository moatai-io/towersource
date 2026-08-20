import React from 'react';
import { useTranslation } from 'react-i18next';
import { toastError, toastSuccess } from '../../utils/toast';

interface ArchivedPersonalFile {
  id: string;
  name: string;
  relativePath: string;
  kind: 'note' | 'file';
  updatedAt: string;
}

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function openPersonalMaterials() {
  window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path: 'personal://materials', split: 'right' } }));
}

export function PersonalArchiveView() {
  const { t } = useTranslation('layout');
  const [files, setFiles] = React.useState<ArchivedPersonalFile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/personal-space/files/archived', { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalArchive.loadFailed'));
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('personalArchive.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => { void load(); }, [load]);

  const restore = async (file: ArchivedPersonalFile) => {
    setRestoringId(file.id);
    try {
      const res = await fetch(`/api/personal-space/files/${encodeURIComponent(file.id)}/restore`, { method: 'POST', headers: authHeaders(true) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalArchive.restoreFailed'));
      setFiles(current => current.filter(item => item.id !== file.id));
      toastSuccess(t('personalArchive.restored', { name: file.name }));
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('personalArchive.restoreFailed'));
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-950 text-surface-100">
      <header className="shrink-0 border-b border-surface-800 px-5 py-4">
        <button type="button" onClick={openPersonalMaterials} className="mb-3 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100" aria-label={t('backToMyMaterials')}>
          <span aria-hidden="true">←</span><span>{t('myMaterials')}</span>
        </button>
        <h2 className="text-xl font-bold">{t('personalArchive.title')}</h2>
        <p className="mt-1 text-[12px] leading-5 text-surface-500">{t('personalArchive.description')}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? <p className="py-12 text-center text-sm text-surface-500">{t('personalArchive.loading')}</p> : files.length === 0 ? (
          <p className="rounded-xl border border-dashed border-surface-700 py-12 text-center text-sm text-surface-500">{t('personalArchive.empty')}</p>
        ) : (
          <div className="divide-y divide-surface-800 border-y border-surface-800">
            {files.map(file => (
              <div key={file.id} className="flex items-center gap-3 py-3">
                <span className="text-lg" aria-hidden="true">{file.kind === 'note' ? '▤' : '□'}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-surface-200">{file.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-surface-600">{t('personalArchive.originalLocation', { path: file.relativePath })}</p>
                </div>
                <button type="button" disabled={restoringId === file.id} onClick={() => { void restore(file); }} className="rounded-md border border-surface-700 px-3 py-1.5 text-[12px] font-semibold text-surface-300 hover:border-primary-500/50 hover:text-primary-300 disabled:opacity-50">{restoringId === file.id ? t('personalArchive.restoring') : t('personalArchive.restore')}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
