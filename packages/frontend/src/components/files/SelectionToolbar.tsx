import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileStore } from '../../stores/file-store';
import { toastError, toastQuiet } from '../../utils/toast';
import { useConfirm } from '../../hooks/useDialog';

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export function compactTopLevelPaths(paths: string[]): string[] {
  const normalized = [...new Set(paths.filter(Boolean))]
    .map((p) => ({ original: p, normalized: p.replace(/\/+$/, '') }))
    .sort((a, b) => a.normalized.length - b.normalized.length);
  const kept: typeof normalized = [];
  for (const candidate of normalized) {
    if (kept.some((parent) => candidate.normalized.startsWith(parent.normalized + '/'))) continue;
    kept.push(candidate);
  }
  return kept.map((p) => p.original);
}

async function apiPost(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/** Floating toolbar that appears when files are selected in multi-select mode */
export function SelectionToolbar({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation('files');
  const confirm = useConfirm();
  const selectedPaths = useFileStore((s) => s.selectedPaths);
  const clearSelection = useFileStore((s) => s.clearSelection);
  const toggleSelectMode = useFileStore((s) => s.toggleSelectMode);
  const selectMode = useFileStore((s) => s.selectMode);
  const setFileClipboard = useFileStore((s) => s.setFileClipboard);

  const [showMoveModal, setShowMoveModal] = useState(false);

  const count = selectedPaths.size;
  if (!selectMode) return null;

  const handleCopy = () => {
    if (count === 0) return;
    const paths = compactTopLevelPaths([...selectedPaths]);
    setFileClipboard(paths);
    clearSelection();
    toggleSelectMode();
    toastQuiet(t('selection.copied', { count: paths.length }));
  };

  const handleDelete = async () => {
    if (count === 0) return;
    const paths = compactTopLevelPaths([...selectedPaths]);
    const msg = count === 1
      ? t('selection.deleteOne', { name: paths[0].split('/').pop() })
      : t('selection.deleteMany', { count });
    const ok = await confirm({
      title: t('selection.deleteTitle'),
      message: msg,
      confirmLabel: t('delete'),
      danger: true,
    });
    if (!ok) return;

    let success = 0;
    let fail = 0;
    for (const path of paths) {
      try {
        await apiPost('/api/files/delete', { path });
        success++;
      } catch {
        fail++;
      }
    }
    if (success > 0) toastQuiet(t('selection.deleted', { count: success }));
    if (fail > 0) toastError(t('selection.deleteFailed', { count: fail }));
    clearSelection();
    onRefresh();
  };

  return (
    <>
      {/* Selection toolbar */}
      <div className="sticky bottom-0 z-30 mx-1 mb-1">
        <div className="bg-surface-800 border border-surface-700 rounded-lg shadow-xl px-3 py-2 flex items-center gap-2">
          {/* Count */}
          <span className="text-[14px] text-primary-400 font-medium whitespace-nowrap">
            {t('selectedCount', { count })}
          </span>

          <div className="flex-1" />

          {/* Copy */}
          <button
            onClick={handleCopy}
            disabled={count === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[13px] bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('copySelected')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {t('copy')}
          </button>

          {/* Download ZIP */}
          <button
            onClick={() => {
              const paths = compactTopLevelPaths([...selectedPaths]);
              const token = localStorage.getItem('token');
              const params = new URLSearchParams();
              params.set('paths', JSON.stringify(paths));
              if (token) params.set('token', token);
              window.open(`/api/files/download-zip-selected?${params.toString()}`, '_blank');
            }}
            disabled={count === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[13px] bg-blue-600/20 text-blue-300 hover:bg-blue-600/30 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('downloadZip')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {t('download')}
          </button>

          {/* Move to folder */}
          <button
            onClick={() => setShowMoveModal(true)}
            disabled={count === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[13px] bg-primary-600/20 text-primary-300 hover:bg-primary-600/30 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('moveToFolder')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            {t('move')}
          </button>

          {/* Delete */}
          <button
            onClick={handleDelete}
            disabled={count === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[13px] bg-red-600/20 text-red-300 hover:bg-red-600/30 hover:text-red-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('deleteSelected')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {t('delete')}
          </button>

          {/* Exit select mode */}
          <button
            onClick={() => toggleSelectMode()}
            className="p-1 rounded text-gray-500 hover:text-white hover:bg-surface-700 transition-colors"
            title={t('exitSelectMode')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Move modal */}
      {showMoveModal && (
        <MoveToFolderModal
          selectedPaths={compactTopLevelPaths([...selectedPaths])}
          onClose={() => setShowMoveModal(false)}
          onComplete={() => {
            setShowMoveModal(false);
            clearSelection();
            if (useFileStore.getState().selectMode) toggleSelectMode();
            useFileStore.getState().bumpRefreshTrigger();
            onRefresh();
          }}
        />
      )}
    </>
  );
}

/** Modal for choosing/creating a destination folder */
export function MoveToFolderModal({ selectedPaths, onClose, onComplete }: {
  selectedPaths: string[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const { t } = useTranslation('files');
  const [targetDir, setTargetDir] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Determine common parent directory from selected files
  const commonParent = (() => {
    if (selectedPaths.length === 0) return '';
    const parts = selectedPaths[0].split('/');
    parts.pop(); // remove file name
    return parts.join('/');
  })();

  // Load directory listing
  const loadDirs = useCallback(async (dirPath: string) => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const url = `/api/files/tree?path=${encodeURIComponent(dirPath)}`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        const folders = (data.entries || []).filter((e: any) => e.isDirectory);
        setDirs(folders);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    if (commonParent) {
      setBrowsePath(commonParent);
      setTargetDir(commonParent);
      loadDirs(commonParent);
    }
  }, [commonParent, loadDirs]);

  useEffect(() => {
    if (showNewFolder) inputRef.current?.focus();
  }, [showNewFolder]);

  const handleNavigate = (dirPath: string) => {
    setBrowsePath(dirPath);
    setTargetDir(dirPath);
    loadDirs(dirPath);
  };

  const handleGoUp = () => {
    const parts = browsePath.split('/');
    parts.pop();
    const parent = parts.join('/');
    if (parent) handleNavigate(parent);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const folderPath = `${browsePath}/${name}`;
    try {
      await apiPost('/api/files/mkdir', { path: folderPath });
      toastQuiet(t('folderCreated', { name }));
      setNewFolderName('');
      setShowNewFolder(false);
      setTargetDir(folderPath);
      loadDirs(browsePath);
    } catch (err: any) {
      toastError(err.message || t('createFolderFailed'));
    }
  };

  const handleMove = async () => {
    if (!targetDir || moving) return;
    setMoving(true);

    let success = 0;
    let fail = 0;
    for (const srcPath of compactTopLevelPaths(selectedPaths)) {
      const fileName = srcPath.split('/').pop() || '';
      const newPath = `${targetDir}/${fileName}`;
      if (srcPath === newPath) { success++; continue; } // already there
      try {
        await apiPost('/api/files/rename', { oldPath: srcPath, newPath });
        success++;
      } catch {
        fail++;
      }
    }

    setMoving(false);
    if (success > 0) toastQuiet(t('selection.moved', { count: success }));
    if (fail > 0) toastError(t('selection.moveFailed', { count: fail }));
    onComplete();
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-[380px] max-h-[480px] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <h3 className="text-base font-medium text-white">{t('moveItemsTitle', { count: selectedPaths.length })}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Current path breadcrumb */}
        <div className="px-4 py-2 border-b border-surface-800 flex items-center gap-1 text-[13px] text-gray-500 overflow-x-auto">
          <button onClick={handleGoUp} className="shrink-0 p-0.5 hover:text-white transition-colors" title={t('goUp')}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="truncate">{browsePath.split('/').slice(-3).join('/')}</span>
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto px-2 py-1 min-h-[140px]">
          {loading ? (
            <p className="text-[14px] text-gray-500 py-4 text-center">{t('loading')}</p>
          ) : dirs.length === 0 ? (
            <p className="text-[14px] text-gray-600 py-4 text-center">{t('noSubfolders')}</p>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-[14px] transition-colors ${
                  targetDir === d.path
                    ? 'bg-primary-600/20 text-primary-300'
                    : 'text-gray-300 hover:bg-surface-800'
                }`}
                onClick={() => setTargetDir(d.path)}
                onDoubleClick={() => handleNavigate(d.path)}
              >
                <svg className="w-4 h-4 text-yellow-400/60 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
                <span className="truncate">{d.name}</span>
              </button>
            ))
          )}
        </div>

        {/* New folder input */}
        {showNewFolder ? (
          <div className="px-4 py-2 border-t border-surface-800 flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); }
              }}
              placeholder={t('newFolderPlaceholder')}
              className="flex-1 bg-surface-950 border border-surface-700 rounded px-2 py-1 text-[14px] text-gray-200 outline-none focus:border-primary-500"
            />
            <button
              onClick={handleCreateFolder}
              className="px-2 py-1 rounded text-[13px] bg-primary-600/30 text-primary-300 hover:bg-primary-600/40 transition-colors"
            >
              {t('create')}
            </button>
            <button
              onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}
              className="p-1 text-gray-500 hover:text-white transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="px-4 py-2 border-t border-surface-800">
            <button
              onClick={() => setShowNewFolder(true)}
              className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-primary-400 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('newFolderHere')}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="px-4 py-3 border-t border-surface-700 flex items-center justify-between">
          <span className="text-[13px] text-gray-500 truncate max-w-[200px]">
            → {targetDir.split('/').slice(-2).join('/')}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded text-[14px] text-gray-400 hover:text-white hover:bg-surface-700 transition-colors"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={handleMove}
              disabled={!targetDir || moving}
              className="px-3 py-1.5 rounded text-[14px] bg-primary-600 text-white hover:bg-primary-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {moving ? t('moving') : t('moveHere')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
