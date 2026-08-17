import { useEffect, useState } from 'react';
import type { SessionMeta } from '@tower/shared';

type BranchSource = { sessionId: string; sessionKey: string; sessionName: string; messageShortId?: string | null; hash?: string };
function headers(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ConversationBranchProvenance({ session }: { session: SessionMeta }) {
  const [source, setSource] = useState<BranchSource | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/sessions/${encodeURIComponent(session.id)}/branch-source`, { headers: headers() })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => { if (live && body) setSource(body); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [session.id]);

  const sourceSessionId = source?.sessionId || session.parentSessionId;
  if (!sourceSessionId) return null;
  return <div className="px-3 md:px-6 pt-2 pb-1 flex justify-center">
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('kanban-select-session', {
        detail: { sessionId: sourceSessionId, sessionKey: source?.sessionKey, hash: source?.hash },
      }))}
      className="tone-muted tone-card min-h-10 max-w-full rounded-full px-3 text-[13px] text-surface-400 hover:text-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      title={source?.sessionName ? `${source.sessionName}의 분기 지점 열기` : '원본 대화 열기'}
    >
      <span className="block truncate">{source?.sessionName ? `${source.sessionName}의 과거 메시지에서 시작됨` : '원본 대화의 과거 메시지에서 시작됨'} · 원본 위치 열기</span>
    </button>
  </div>;
}
