/**
 * OAuthConnections — 외부 서비스 연결 관리 UI.
 * Settings 모달 안에 렌더링됩니다.
 *
 * 두 섹션:
 * 1. Connections — 개인 OAuth provider 연결 현황 (Google, Kakao, Telegram 등)
 * 2. Skill Readiness — 내가 쓸 수 있는/없는 스킬 현황 (credential 기반)
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus, SkillReadiness } from '@tower/shared';
import { emitProductNotice } from '../../utils/product-notice';
import { useConfirm } from '../../hooks/useDialog';

interface ProviderStatus {
  connected: boolean;
  nickname?: string;
}

interface ProviderConfig {
  id: string;
  name: string;
  icon: string;
  color: string;
  connectedColor: string;
  connectMode: 'oauth' | 'deeplink';
}

// kakao/telegram provider 는 #58 (외부 메시징 폐기) Phase 4 에서 제거됨. google 만 유지.
const PROVIDERS: ProviderConfig[] = [
  {
    id: 'google',
    name: 'Google',
    icon: '🔵',
    color: 'text-blue-400 border-blue-500/30 hover:bg-blue-500/10',
    connectedColor: 'text-blue-300 border-blue-500/50 bg-blue-500/10',
    connectMode: 'oauth',
  },
];

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export function OAuthConnections() {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const [status, setStatus] = useState<Record<string, ProviderStatus>>({});
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [skillReadiness, setSkillReadiness] = useState<SkillReadiness[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [showReadiness, setShowReadiness] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/auth/oauth/status', { headers: getAuthHeaders() });
      if (res.ok) setStatus(await res.json());
    } catch {}
  };

  const fetchConnections = async () => {
    try {
      const res = await fetch('/api/me/connections', { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setConnections(Array.isArray(data) ? data : Array.isArray(data?.connections) ? data.connections : []);
      }
    } catch { setConnections([]); }
  };

  const fetchSkillReadiness = async () => {
    try {
      const res = await fetch('/api/me/skill-readiness', { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSkillReadiness(Array.isArray(data) ? data : Array.isArray(data?.skills) ? data.skills : Array.isArray(data?.readiness) ? data.readiness : []);
      }
    } catch { setSkillReadiness([]); }
  };

  useEffect(() => {
    fetchStatus();
    fetchConnections();

    // Check if returning from OAuth callback
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth')) {
      window.history.replaceState({}, '', window.location.pathname);
      fetchStatus();
      fetchConnections();
    }
  }, []);

  // Load skill readiness on demand
  useEffect(() => {
    if (showReadiness && skillReadiness.length === 0) {
      fetchSkillReadiness();
    }
  }, [showReadiness]);

  const connect = async (provider: string, _mode: 'oauth' | 'deeplink') => {
    setLoading(provider);
    try {
      // OAuth redirect flow (Google). deeplink(Telegram) 흐름은 #58 Phase 4 에서 제거.
      const res = await fetch(`/api/auth/${provider}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      emitProductNotice({
        code: 'oauth.connect.failed',
        context: { provider },
        technicalDetail: data.error,
      });
    } catch (err: unknown) {
      emitProductNotice({
        code: 'oauth.connect.failed',
        context: { provider },
        technicalDetail: err,
      });
    } finally {
      setLoading(null);
    }
  };

  const disconnect = async (provider: string) => {
    const ok = await confirm({
      title: t('oauthConnections.disconnectTitle'),
      message: t('oauthConnections.disconnectMessage'),
      confirmLabel: t('oauthConnections.disconnect'),
      danger: true,
    });
    if (!ok) return;
    setLoading(provider);
    try {
      await fetch(`/api/auth/oauth/${provider}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      await fetchStatus();
      await fetchConnections();
      if (showReadiness) await fetchSkillReadiness();
    } finally {
      setLoading(null);
    }
  };

  // 외부 메시징 testMessage 는 #58 Phase 4 에서 제거됨.

  // Merge PROVIDERS config with live connection status
  const getProviderStatus = (providerId: string) => {
    const s = status[providerId];
    const c = connections.find(c => c.provider === providerId);
    return {
      connected: s?.connected || c?.connected || false,
      nickname: s?.nickname || c?.nickname || undefined,
    };
  };

  return (
    <>
      {/* ── Connections ── */}
      <section>
        <h3 className="text-[14px] font-semibold text-surface-500 uppercase tracking-wider mb-3">
          {t('oauthConnections.title')}
        </h3>
        <div className="space-y-2">
          {PROVIDERS.map((p) => {
            const s = getProviderStatus(p.id);
            const connected = s.connected;
            const isLoading = loading === p.id;

            return (
              <div key={p.id}>
                <div
                  className={`flex items-center justify-between py-2.5 px-3 rounded-lg border transition-all ${
                    connected ? p.connectedColor : 'border-surface-700'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-lg shrink-0">{p.icon}</span>
                    <span className="text-sm font-medium text-gray-200">{p.name}</span>
                    {connected && s.nickname && (
                      <span className="text-[12px] text-surface-500 truncate">({s.nickname})</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {connected ? (
                      <button
                        onClick={() => disconnect(p.id)}
                        disabled={isLoading}
                        className="px-2 py-1 text-[12px] font-medium text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                      >
                        {t('oauthConnections.disconnect')}
                      </button>
                    ) : (
                      <button
                        onClick={() => connect(p.id, p.connectMode)}
                        disabled={isLoading}
                        className={`px-3 py-1 text-[12px] font-semibold rounded-md border transition-all disabled:opacity-50 ${p.color}`}
                      >
                        {isLoading ? t('oauthConnections.connecting') : t('oauthConnections.connect')}
                      </button>
                    )}
                  </div>
                </div>

                {/* Telegram deep link 대기 UI 는 #58 Phase 4 에서 제거됨. */}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Skill Readiness ── */}
      <section>
        <button
          onClick={() => setShowReadiness(!showReadiness)}
          className="flex items-center gap-1.5 text-[14px] font-semibold text-surface-500 uppercase tracking-wider mb-3 hover:text-surface-400 transition-colors"
        >
          <span className="text-[12px]">{showReadiness ? '▼' : '▶'}</span>
          {t('oauthConnections.skillReadiness')}
          {skillReadiness.length > 0 && (
            <span className="ml-1 text-[12px] font-normal normal-case">
              {t('oauthConnections.readyCount', { ready: skillReadiness.filter(s => s.ready).length, total: skillReadiness.length })}
            </span>
          )}
        </button>

        {showReadiness && (
          <div className="space-y-1.5">
            {skillReadiness.length === 0 ? (
              <p className="text-[13px] text-surface-600 px-2">
                {t('oauthConnections.noCredentialSkills')}
              </p>
            ) : (
              skillReadiness.map((skill) => (
                <div
                  key={skill.skillId}
                  className={`flex items-center justify-between py-2 px-3 rounded-lg border transition-all ${
                    skill.ready
                      ? 'tone-success tone-border tone-bg-soft'
                      : 'tone-warning tone-border tone-bg-soft'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px]">{skill.ready ? '✅' : '⚠️'}</span>
                    <span className="text-sm font-medium text-gray-300">{skill.skillName}</span>
                  </div>
                  {!skill.ready && (
                    <span className="tone-warning tone-text text-[12px]">
                      {t('oauthConnections.missingConnections', { connections: skill.missing.join(', ') })}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </>
  );
}
