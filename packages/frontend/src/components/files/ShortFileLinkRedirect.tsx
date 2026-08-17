import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Resolve `/f/:shortId` into the existing authenticated file viewer route. */
export function ShortFileLinkRedirect() {
  const { shortId } = useParams();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!shortId) {
      setError('잘못된 파일 링크입니다.');
      return;
    }

    fetch(`/api/file-links/${encodeURIComponent(shortId)}`, { headers: getAuthHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || '파일 링크를 열 수 없습니다.');
        }
        return res.json();
      })
      .then((data) => {
        const filePath = data.filePath || data.path;
        if (!filePath) throw new Error('파일 경로가 없습니다.');
        window.location.replace(`/file-viewer?path=${encodeURIComponent(filePath)}`);
      })
      .catch((err: any) => setError(err.message || '파일 링크를 열 수 없습니다.'));
  }, [shortId]);

  return (
    <div className="flex items-center justify-center bg-surface-950 text-surface-100" style={{ height: '100dvh' }}>
      <div className="rounded-2xl border border-surface-700 bg-surface-900 px-6 py-5 text-center shadow-xl">
        {error ? (
          <>
            <div className="mb-3 text-4xl">🔗</div>
            <div className="text-sm text-surface-300">{error}</div>
          </>
        ) : (
          <div className="text-sm text-surface-300">파일 링크를 여는 중...</div>
        )}
      </div>
    </div>
  );
}
