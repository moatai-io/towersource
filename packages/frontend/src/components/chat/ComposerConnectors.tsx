import { useEffect, useState } from 'react';
import { McpConnectionManager } from './McpConnectionManager';

type Connection = { id: string; name?: string; displayName?: string; transport?: string; status: string; enabled?: boolean; error?: string };
type Selection = { excludedServerNames: string[]; supported: boolean };
function headers(json = false) {
  const token = localStorage.getItem('token');
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: headers(!!init?.body), credentials: 'same-origin' });
  if (!response.ok) throw new Error(response.status === 403 ? '이 연결을 사용할 권한이 없습니다.' : '연결 정보를 가져오지 못했습니다. 다시 시도해 주세요.');
  return response.json();
}

export function ComposerConnectors({ projectId, sessionId }: { projectId: string; sessionId?: string | null }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setConnections([]); setSelection(null); setCanManage(false);
    Promise.all([
      request<{ connections: Connection[]; canManage?: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/mcp/connections`, { signal: controller.signal }),
      sessionId ? request<Selection>(`/api/sessions/${encodeURIComponent(sessionId)}/mcp-selection`, { signal: controller.signal }) : Promise.resolve(null),
    ]).then(([catalog, selected]) => { if (!controller.signal.aborted) { setConnections(catalog.connections); setCanManage(!!catalog.canManage); setSelection(selected); } })
      .catch(() => { if (!controller.signal.aborted) setError('커넥터 정보를 가져오지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, sessionId, revision]);
  async function toggle(id: string) {
    if (!selection || !sessionId || saving) return;
    const excludedServerNames = selection.excludedServerNames.includes(id) ? selection.excludedServerNames.filter(value => value !== id) : [...selection.excludedServerNames, id];
    setSaving(true); setError('');
    try {
      const updated = await request<Selection>(`/api/sessions/${encodeURIComponent(sessionId)}/mcp-selection`, { method: 'PATCH', body: JSON.stringify({ excludedServerNames, projectId }) });
      setSelection(updated);
    } catch (err) { setError(err instanceof Error ? err.message : '설정을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }
  return <div>
    <p className="px-3 py-2 text-xs leading-relaxed text-surface-400">Agent 공용 연결입니다. 선택 변경은 다음 도구 검색·호출부터 적용됩니다.</p>
    {loading && <p role="status" className="px-3 py-3 text-sm text-surface-400">연결 정보를 확인하는 중입니다.</p>}
    {error && <p role="alert" className="px-3 py-2 text-sm text-red-400">{error}</p>}
    {!loading && !error && !connections.length && <p className="px-3 py-3 text-sm text-surface-400">등록된 MCP 커넥터가 없습니다.</p>}
    <div className="max-h-64 overflow-y-auto">
      {connections.map(connection => <label key={connection.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-700/40">
        <span className="min-w-0 flex-1"><span className="block truncate text-sm">{connection.displayName || connection.name || connection.id}</span><span className="block text-xs text-surface-400">{connection.status === 'disconnected' || connection.status === 'auth_required' ? '로그인이 필요합니다' : connection.status === 'connected' ? '인증됨 · 실행 시 연결 확인' : connection.status === 'disabled' ? '관리 설정에서 비활성화됨' : connection.status === 'error' ? '연결을 확인해 주세요' : '등록됨 · 실행 시 연결 확인'}</span></span>
        <input type="checkbox" role="switch" aria-label={`${connection.displayName || connection.name || connection.id} 이번 대화에서 사용`} checked={!!selection && !selection.excludedServerNames.includes(connection.id)} disabled={saving || !selection?.supported || connection.enabled === false} onChange={() => void toggle(connection.id)} className="h-4 w-4 accent-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400" />
      </label>)}
    </div>
    {canManage && <McpConnectionManager projectId={projectId} connections={connections} request={request} onChanged={() => setRevision(value => value + 1)} />}
    {selection && !selection.supported && <p className="px-3 py-2 text-xs text-surface-400">Pi 대화에서만 사용 여부를 변경할 수 있습니다.</p>}
    <p className="border-t border-surface-700 px-3 py-2 text-xs leading-relaxed text-surface-400">이 설정은 MCP 도구 사용을 제한합니다. 일반 shell의 외부 접근을 차단하는 보안 설정은 아닙니다.</p>
  </div>;
}
