import { useState, useEffect, useRef } from 'react';
import { toastSuccess, toastError } from '../../utils/toast';

interface User { id: number; username: string; }
interface SessionShareItem {
  id: string;
  share_type: 'internal' | 'external';
  token?: string;
  expires_at?: string;
  target_username?: string;
  url?: string;
}

interface Props {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export function SessionShareModal({ sessionId, sessionName, onClose }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('');
  const [expiresIn, setExpiresIn] = useState<'1h' | '24h' | '7d'>('24h');
  const [shares, setShares] = useState<SessionShareItem[]>([]);
  const [generatedUrl, setGeneratedUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [showExternal, setShowExternal] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState(window.location.origin);
  const [linkCopied, setLinkCopied] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/health', { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { if (d.sharePublicUrl || d.publicUrl) setSiteOrigin(d.sharePublicUrl || d.publicUrl); })
      .catch(() => {});
    fetch('/api/users', { headers: getAuthHeaders() })
      .then(r => r.json()).then(setUsers).catch(() => {});
    loadShares();
  }, [sessionId]);

  const loadShares = () => {
    fetch(`/api/session-shares?sessionId=${encodeURIComponent(sessionId)}`, { headers: getAuthHeaders() })
      .then(r => r.json()).then(setShares).catch(() => {});
  };

  const deepLink = `${siteOrigin}/s/${sessionId}`;

  const handleCopyDeepLink = async () => {
    try {
      await navigator.clipboard.writeText(deepLink);
      setLinkCopied(true);
      toastSuccess('링크가 복사되었습니다');
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toastError('링크를 복사할 수 없습니다');
    }
  };

  const handleInternalShare = async () => {
    if (!selectedUserId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/session-shares', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({ shareType: 'internal', sessionId, targetUserId: selectedUserId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      toastSuccess('공유 완료');
      setSelectedUserId('');
      loadShares();
    } catch (e: any) { toastError(e.message); }
    finally { setLoading(false); }
  };

  const handleExternalShare = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/session-shares', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({ shareType: 'external', sessionId, expiresIn }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      const data = await res.json();
      const fullUrl = `${siteOrigin}${data.url}`;
      setGeneratedUrl(fullUrl);
      loadShares();
      try {
        await navigator.clipboard.writeText(fullUrl);
        toastSuccess('외부 링크 생성 및 복사 완료!');
      } catch {
        toastSuccess('외부 링크가 생성되었습니다.');
      }
    } catch (e: any) { toastError(e.message); }
    finally { setLoading(false); }
  };

  const handleRevoke = async (shareId: string) => {
    try {
      const res = await fetch(`/api/session-shares/${shareId}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) throw new Error((await res.json()).error);
      toastSuccess('공유가 취소되었습니다.');
      setShares(prev => prev.filter(s => s.id !== shareId));
      if (generatedUrl) setGeneratedUrl('');
    } catch (e: any) { toastError(e.message); }
  };

  const externalShares = shares.filter(s => s.share_type === 'external');
  const internalShares = shares.filter(s => s.share_type === 'internal');

  const timeLeft = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return '만료됨';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}시간 남음` : `${m}분 남음`;
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="bg-surface-800 border border-surface-700 rounded-xl shadow-2xl w-[420px] max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div>
            <h2 className="text-[15px] font-semibold text-white">세션 공유</h2>
            <p className="text-[13px] text-gray-500 truncate max-w-[300px]">{sessionName}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* ── Deep link (primary action) ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-primary-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <span className="text-[14px] text-white font-medium">공유 링크</span>
            </div>
            <div className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2.5">
              <span className="flex-1 text-[13px] text-gray-400 truncate select-all">{deepLink}</span>
              <button
                onClick={handleCopyDeepLink}
                className={`shrink-0 px-2.5 py-1 rounded text-[13px] font-medium transition-all ${
                  linkCopied
                    ? 'tone-success tone-bg-soft tone-text'
                    : 'bg-primary-600/20 text-primary-400 hover:bg-primary-600/30'
                }`}
              >
                {linkCopied ? '복사됨' : '복사'}
              </button>
            </div>
            <p className="text-[12px] text-gray-600">
              로그인된 팀원이 이 링크로 세션에 바로 접근합니다. 같은 프로젝트 멤버이거나 아래에서 접근 권한을 부여한 유저만 볼 수 있습니다.
            </p>
          </div>

          {/* ── Share with specific user ── */}
          <div className="border-t border-surface-700/50 pt-3 space-y-2">
            <div className="flex items-center gap-2">
              <svg className="tone-success tone-text w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              <span className="text-[14px] text-white font-medium">접근 권한 부여</span>
            </div>
            <div className="flex gap-2">
              <select
                value={selectedUserId}
                onChange={e => setSelectedUserId(Number(e.target.value) || '')}
                className="flex-1 bg-surface-900 border border-surface-600 rounded-lg px-3 py-2 text-[14px] text-white focus:outline-none focus:border-primary-500"
              >
                <option value="">유저 선택...</option>
                {users.map(u => <option key={u.id} value={u.id}>@{u.username}</option>)}
              </select>
              <button
                onClick={handleInternalShare}
                disabled={loading || !selectedUserId}
                className="px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-white text-[14px] font-medium transition-colors shrink-0"
              >
                {loading ? '...' : '추가'}
              </button>
            </div>
          </div>

          {/* ── Current shares list ── */}
          {internalShares.length > 0 && (
            <div className="space-y-1.5">
              {internalShares.map(s => (
                <div key={s.id} className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2">
                  <svg className="tone-success tone-text w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span className="flex-1 text-[13px] text-gray-400">@{s.target_username}</span>
                  <button onClick={() => handleRevoke(s.id)} className="text-[12px] text-red-400 hover:text-red-300 shrink-0">제거</button>
                </div>
              ))}
            </div>
          )}

          {/* ── External link (collapsed) ── */}
          <div className="border-t border-surface-700/50 pt-3">
            <button
              onClick={() => setShowExternal(!showExternal)}
              className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg className={`w-3 h-3 transition-transform ${showExternal ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              외부 공유 링크 만들기
              <span className="text-[12px] text-gray-600">(비로그인 접근, 스냅샷)</span>
            </button>

            {showExternal && (
              <div className="mt-3 space-y-3 pl-1">
                <p className="tone-card tone-warning text-[12px] rounded-lg px-3 py-2 opacity-80">
                  외부 링크는 로그인 없이 접근 가능합니다. 공유 시점의 대화 스냅샷만 포함되며, 이후 대화는 반영되지 않습니다.
                </p>
                <div className="flex gap-2 items-center">
                  <div className="flex gap-1.5 flex-1">
                    {(['1h', '24h', '7d'] as const).map(opt => (
                      <button key={opt}
                        onClick={() => setExpiresIn(opt)}
                        className={`flex-1 py-1.5 rounded text-[13px] font-medium border transition-colors ${
                          expiresIn === opt
                            ? 'bg-primary-600/30 border-primary-500/50 text-primary-300'
                            : 'border-surface-600 text-gray-500 hover:border-surface-500 hover:text-gray-300'
                        }`}
                      >
                        {opt === '1h' ? '1시간' : opt === '24h' ? '24시간' : '7일'}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={handleExternalShare}
                    disabled={loading}
                    className="px-4 py-1.5 rounded-lg bg-surface-700 hover:bg-surface-600 border border-surface-600 disabled:opacity-50 text-white text-[13px] font-medium transition-colors shrink-0"
                  >
                    {loading ? '생성 중...' : '생성'}
                  </button>
                </div>
                {generatedUrl && (
                  <div className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2">
                    <span className="flex-1 text-[13px] text-gray-400 truncate">{generatedUrl}</span>
                    <button
                      onClick={() => { navigator.clipboard.writeText(generatedUrl); toastSuccess('복사됨'); }}
                      className="text-primary-400 hover:text-primary-300 text-[12px] shrink-0 font-medium"
                    >복사</button>
                  </div>
                )}
              </div>
            )}

            {/* External shares list */}
            {externalShares.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {externalShares.map(s => (
                  <div key={s.id} className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2">
                    <svg className="tone-warning tone-text w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="flex-1 text-[13px] text-gray-400">
                      외부 링크 · {s.expires_at ? timeLeft(s.expires_at) : ''}
                    </span>
                    <button onClick={() => handleRevoke(s.id)} className="text-[12px] text-red-400 hover:text-red-300 shrink-0">취소</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
