import React from 'react';
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
  const [files, setFiles] = React.useState<ArchivedPersonalFile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/personal-space/files/archived', { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '보관함을 불러오지 못했습니다.');
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (error) {
      toastError(error instanceof Error ? error.message : '보관함을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const restore = async (file: ArchivedPersonalFile) => {
    setRestoringId(file.id);
    try {
      const res = await fetch(`/api/personal-space/files/${encodeURIComponent(file.id)}/restore`, { method: 'POST', headers: authHeaders(true) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '파일을 복원하지 못했습니다.');
      setFiles(current => current.filter(item => item.id !== file.id));
      toastSuccess(`${file.name}을 복원했습니다.`);
    } catch (error) {
      toastError(error instanceof Error ? error.message : '파일을 복원하지 못했습니다.');
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-950 text-surface-100">
      <header className="shrink-0 border-b border-surface-800 px-5 py-4">
        <button type="button" onClick={openPersonalMaterials} className="mb-3 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100" aria-label="내 자료로 돌아가기">
          <span aria-hidden="true">←</span><span>내 자료</span>
        </button>
        <h2 className="text-xl font-bold">보관함</h2>
        <p className="mt-1 text-[12px] leading-5 text-surface-500">보관한 파일은 내 파일 목록에서 숨겨집니다. 필요할 때 원래 위치로 복원하세요.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? <p className="py-12 text-center text-sm text-surface-500">보관함을 불러오는 중…</p> : files.length === 0 ? (
          <p className="rounded-xl border border-dashed border-surface-700 py-12 text-center text-sm text-surface-500">보관한 파일이 없습니다.</p>
        ) : (
          <div className="divide-y divide-surface-800 border-y border-surface-800">
            {files.map(file => (
              <div key={file.id} className="flex items-center gap-3 py-3">
                <span className="text-lg" aria-hidden="true">{file.kind === 'note' ? '▤' : '□'}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-surface-200">{file.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-surface-600">원래 위치 · {file.relativePath}</p>
                </div>
                <button type="button" disabled={restoringId === file.id} onClick={() => { void restore(file); }} className="rounded-md border border-surface-700 px-3 py-1.5 text-[12px] font-semibold text-surface-300 hover:border-primary-500/50 hover:text-primary-300 disabled:opacity-50">{restoringId === file.id ? '복원 중…' : '복원'}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
