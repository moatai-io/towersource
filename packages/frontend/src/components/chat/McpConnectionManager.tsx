import { useState } from 'react';

type Connection = { id: string; displayName?: string; name?: string; status: string };
export function McpConnectionManager({ projectId, connections, onChanged, request }: {
  projectId: string; connections: Connection[]; onChanged: () => void;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [oauth, setOauth] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ id: string; action: 'login' | 'remove' | 'disconnect' } | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}/mcp/connections`;
  const button = 'rounded-md border border-surface-700 px-2.5 py-1.5 text-xs hover:bg-surface-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50';
  async function add(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await request(base, { method: 'POST', body: JSON.stringify({ name, url, authType: oauth ? 'oauth' : 'none' }) });
      setAdding(false); setName(''); setUrl(''); onChanged();
    } catch { setError('커넥터를 추가하지 못했습니다. 이름과 HTTPS 주소를 확인해 주세요.'); }
    finally { setBusy(false); }
  }
  async function act() {
    if (!confirm) return;
    setBusy(true); setError('');
    try {
      const endpoint = `${base}/${encodeURIComponent(confirm.id)}`;
      if (confirm.action === 'login') {
        const result = await request<{ authorizationUrl: string }>(`${endpoint}/auth/start`, { method: 'POST', body: JSON.stringify({ acknowledgeSharedAccount: true }) });
        const target = new URL(result.authorizationUrl);
        if (target.protocol !== 'https:') throw new Error('Unsafe authorization URL');
        window.location.assign(target.href);
      } else {
        await request(confirm.action === 'disconnect' ? `${endpoint}/auth` : endpoint, { method: 'DELETE' });
        onChanged();
      }
      setConfirm(null);
    } catch { setError('연결 작업을 완료하지 못했습니다. 권한과 서버 설정을 확인해 주세요.'); }
    finally { setBusy(false); }
  }
  return <div className="border-t border-surface-700 px-3 py-2">
    <details>
      <summary className="cursor-pointer py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">커넥터 추가·관리</summary>
      <p className="my-2 text-xs leading-relaxed text-surface-400">로그인한 계정은 이 Agent의 허용된 사용자들이 함께 사용합니다. 개인 계정을 연결하기 전에 공유 범위를 확인하세요.</p>
      {connections.map(connection => <div key={connection.id} className="my-2 flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{connection.displayName || connection.name || connection.id}</span><button className={button} disabled={busy} onClick={() => setConfirm({ id: connection.id, action: 'login' })}>로그인</button>{connection.status === 'connected' && <button className={button} disabled={busy} onClick={() => setConfirm({ id: connection.id, action: 'disconnect' })}>인증 해제</button>}<button className={button} disabled={busy} onClick={() => setConfirm({ id: connection.id, action: 'remove' })}>삭제</button></div>)}
      {!adding ? <button className={button} disabled={busy} onClick={() => setAdding(true)}>+ 원격 MCP 추가</button> : <form onSubmit={event => void add(event)} className="space-y-2 py-2">
        <label className="block text-xs">이름<input required pattern="[A-Za-z0-9_-]+" maxLength={64} value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded-md border border-surface-700 bg-transparent px-2 py-2" placeholder="예: notes" /></label>
        <label className="block text-xs">MCP 서버 주소<input required type="url" value={url} onChange={event => setUrl(event.target.value)} className="mt-1 w-full rounded-md border border-surface-700 bg-transparent px-2 py-2" placeholder="https://service.example.com/mcp" /></label>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={oauth} onChange={event => setOauth(event.target.checked)} />OAuth 로그인 사용</label>
        <div className="flex gap-2"><button type="submit" className={button} disabled={busy}>추가</button><button type="button" className={button} disabled={busy} onClick={() => setAdding(false)}>취소</button></div>
      </form>}
      {confirm && <div role="group" aria-label="연결 변경 확인" className="my-3 space-y-2 rounded-lg border border-surface-600 p-3">
        <p className="text-xs leading-relaxed">{confirm.action === 'login' ? `${confirm.id}에 로그인한 계정을 Agent 사용자들과 공유합니다. 로그인할까요?` : confirm.action === 'remove' ? `${confirm.id} 연결을 삭제하면 이 Agent의 모든 대화에서 사용할 수 없습니다. 삭제할까요?` : `${confirm.id}의 공용 인증을 해제하면 다른 사용자도 다시 로그인해야 합니다. 해제할까요?`}</p>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void act()}>확인</button><button className={button} disabled={busy} onClick={() => setConfirm(null)}>취소</button></div>
      </div>}
      {error && <p role="alert" className="py-2 text-xs text-red-400">{error}</p>}
    </details>
  </div>;
}
