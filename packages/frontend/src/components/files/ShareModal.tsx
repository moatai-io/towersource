import React, { useState, useEffect, useRef } from 'react';
import { toastSuccess, toastError } from '../../utils/toast';
import { createTowerFileShortLink } from '../../utils/file-path-links';
import { useTranslation } from 'react-i18next';

interface User { id: number; username: string; }
interface Share {
  id: string;
  share_type: 'internal' | 'external';
  token?: string;
  expires_at?: string;
  target_username?: string;
  url?: string;
}

interface Props {
  filePath: string;
  onClose: () => void;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

type ExternalExpiry = '1h' | '24h' | '7d' | '3mo' | 'unlimited';

const EXTERNAL_EXPIRY_OPTIONS: Array<{ value: ExternalExpiry; labelKey: string }> = [
  { value: '1h', labelKey: 'oneHour' },
  { value: '24h', labelKey: 'twentyFourHours' },
  { value: '7d', labelKey: 'sevenDays' },
  { value: '3mo', labelKey: 'threeMonths' },
  { value: 'unlimited', labelKey: 'unlimited' },
];

export function ShareModal({ filePath, onClose }: Props) {
  const { t } = useTranslation('files');
  const [tab, setTab] = useState<'internal' | 'external'>('external');
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('');
  const [expiresIn, setExpiresIn] = useState<ExternalExpiry>('24h');
  const [shares, setShares] = useState<Share[]>([]);
  const [generatedUrl, setGeneratedUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState(window.location.origin);
  const overlayRef = useRef<HTMLDivElement>(null);

  const fileName = filePath.split('/').pop() ?? filePath;

  const copyInternalLink = async () => {
    try {
      const internalUrl = await createTowerFileShortLink(filePath);
      await navigator.clipboard.writeText(internalUrl.replace(window.location.origin, siteOrigin));
      toastSuccess(t('internalShortLinkCopied'));
    } catch {
      toastError(t('internalLinkCopyFailed'));
    }
  };

  useEffect(() => {
    // 서버에 설정된 PUBLIC_URL 우선 사용 — 없으면 현재 origin 폴백
    fetch('/api/health', { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { if (d.sharePublicUrl || d.publicUrl) setSiteOrigin(d.sharePublicUrl || d.publicUrl); })
      .catch(() => {});
    fetch('/api/users', { headers: getAuthHeaders() })
      .then(r => r.json()).then(setUsers).catch(() => {});
    loadShares();
  }, [filePath]);

  const loadShares = () => {
    fetch(`/api/shares?filePath=${encodeURIComponent(filePath)}`, { headers: getAuthHeaders() })
      .then(r => r.json()).then(setShares).catch(() => {});
  };

  const handleInternalShare = async () => {
    if (!selectedUserId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/shares', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({ shareType: 'internal', filePath, targetUserId: selectedUserId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      toastSuccess(t('shared'));
      setSelectedUserId('');
      loadShares();
    } catch (e: any) { toastError(e.message); }
    finally { setLoading(false); }
  };

  const handleExternalShare = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/shares', {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({ shareType: 'external', filePath, expiresIn }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      const data = await res.json();
      const fullUrl = `${siteOrigin}${data.url}`;
      setGeneratedUrl(fullUrl);
      loadShares();
      // 클립보드 복사는 별도 처리 — 실패해도 링크 생성은 성공
      try {
        await navigator.clipboard.writeText(fullUrl);
        toastSuccess(t('linkCreatedAndCopied'));
      } catch {
        toastSuccess(t('linkCreatedCopyBelow'));
      }
    } catch (e: any) { toastError(e.message); }
    finally { setLoading(false); }
  };

  const handleRevoke = async (shareId: string) => {
    try {
      const res = await fetch(`/api/shares/${shareId}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) throw new Error((await res.json()).error);
      toastSuccess(t('shareRevoked'));
      setShares(prev => prev.filter(s => s.id !== shareId));
      if (generatedUrl) setGeneratedUrl('');
    } catch (e: any) { toastError(e.message); }
  };

  const externalShares = shares.filter(s => s.share_type === 'external');
  const internalShares = shares.filter(s => s.share_type === 'internal');

  const timeLeft = (expiresAt?: string) => {
    if (!expiresAt) return t('unlimited');
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return t('expired');
    const d = Math.floor(ms / 86400000);
    if (d > 0) return t('daysRemaining', { count: d });
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? t('hoursRemaining', { count: h }) : t('minutesRemaining', { count: m });
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
            <h2 className="text-[15px] font-semibold text-white">{t('shareFile')}</h2>
            <p className="text-[13px] text-gray-500 truncate max-w-[300px]">{fileName}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-surface-700">
          {(['external', 'internal'] as const).map(tabName => (
            <button key={tabName}
              onClick={() => setTab(tabName)}
              className={`flex-1 py-2 text-[14px] font-medium transition-colors ${
                tab === tabName
                  ? 'text-primary-400 border-b-2 border-primary-500'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tabName === 'external' ? t('externalLink') : t('internalLink')}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-4">
          {/* External tab */}
          {tab === 'external' && (
            <div className="space-y-3">
              <div className="grid grid-cols-5 gap-2">
                {EXTERNAL_EXPIRY_OPTIONS.map(opt => (
                  <button key={opt.value}
                    onClick={() => setExpiresIn(opt.value)}
                    className={`py-1.5 rounded text-[13px] font-medium border transition-colors ${
                      expiresIn === opt.value
                        ? 'bg-primary-600/30 border-primary-500/50 text-primary-300'
                        : 'border-surface-600 text-gray-500 hover:border-surface-500 hover:text-gray-300'
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
              <button
                onClick={handleExternalShare}
                disabled={loading}
                className="w-full py-2 rounded-lg bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-white text-[14px] font-medium transition-colors"
              >
                {loading ? t('creating') : t('createAndCopyLink')}
              </button>
              {generatedUrl && (
                <div className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2">
                  <span className="flex-1 text-[13px] text-gray-400 truncate">{generatedUrl}</span>
                  <button
                    onClick={() => { navigator.clipboard.writeText(generatedUrl); toastSuccess(t('copied')); }}
                    className="text-primary-400 hover:text-primary-300 text-[12px] shrink-0"
                  >{t('copy')}</button>
                </div>
              )}
            </div>
          )}

          {/* Internal link + user share tab */}
          {tab === 'internal' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-surface-700/70 bg-surface-900/70 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <svg className="mt-0.5 w-3.5 h-3.5 text-primary-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-gray-300">{t('internalLink')}</div>
                    <div className="mt-0.5 text-[12px] leading-4 text-surface-500">{t('internalLinkAccessHint')}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-surface-950/70 px-2 py-1.5">
                  <span className="flex-1 truncate text-[12px] text-surface-500">{siteOrigin}/f/…</span>
                  <button
                    onClick={copyInternalLink}
                    className="text-[12px] font-medium text-primary-400 hover:text-primary-300 shrink-0"
                  >{t('copy')}</button>
                </div>
              </div>

              <div className="pt-1 text-[12px] font-medium uppercase tracking-wide text-surface-600">{t('orShareWithUser')}</div>
              <select
                value={selectedUserId}
                onChange={e => setSelectedUserId(Number(e.target.value) || '')}
                className="w-full bg-surface-900 border border-surface-600 rounded-lg px-3 py-2 text-[14px] text-white focus:outline-none focus:border-primary-500"
              >
                <option value="">{t('selectUser')}</option>
                {users.map(u => <option key={u.id} value={u.id}>@{u.username}</option>)}
              </select>
              <button
                onClick={handleInternalShare}
                disabled={loading || !selectedUserId}
                className="w-full py-2 rounded-lg bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-white text-[14px] font-medium transition-colors"
              >
                {loading ? t('sharing') : t('share')}
              </button>
            </div>
          )}

          {/* Share list */}
          {(externalShares.length > 0 || internalShares.length > 0) && (
            <div className="border-t border-surface-700/50 pt-3">
              <h3 className="text-[13px] text-gray-500 mb-2 font-medium uppercase tracking-wide">{t('currentShares')}</h3>
              <div className="space-y-1.5">
                {externalShares.map(s => (
                  <div key={s.id} className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2">
                    <svg className="w-3.5 h-3.5 text-primary-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="flex-1 text-[13px] text-gray-400">
                      {t('externalLink')} · {timeLeft(s.expires_at)}
                    </span>
                    <button onClick={() => handleRevoke(s.id)} className="text-[12px] text-red-400 hover:text-red-300 shrink-0">{t('cancel')}</button>
                  </div>
                ))}
                {internalShares.map(s => (
                  <div key={s.id} className="flex items-center gap-2 bg-surface-900 rounded-lg px-3 py-2">
                    <svg className="tone-success tone-text w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    <span className="flex-1 text-[13px] text-gray-400">@{s.target_username}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
