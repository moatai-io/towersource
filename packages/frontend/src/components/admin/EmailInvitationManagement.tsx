import React, { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '../../hooks/useDialog';

interface Invitation {
  id: number;
  email: string;
  role: string;
  status: string;
  expires_at: string;
}

export function EmailInvitationManagement({ token, roles }: { token?: string | null; roles: string[] }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const headers = useCallback(() => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }), [token]);
  const load = useCallback(async () => {
    const response = await fetch('/api/admin/account-email-invitations', { headers: headers(), cache: 'no-store' });
    if (!response.ok) throw new Error('초대 목록을 불러오지 못했습니다.');
    setRows(await response.json());
  }, [headers]);
  useEffect(() => { void load().catch(err => setError(err.message)); }, [load]);

  const run = async (action: 'create' | 'resend' | 'cancel', id?: number) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const path = action === 'create' ? '' : `/${id}/${action}`;
      const response = await fetch(`/api/admin/account-email-invitations${path}`, {
        method: 'POST', headers: headers(),
        ...(action === 'create' ? { body: JSON.stringify({ email: email.trim(), role }) } : {}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '초대 요청을 처리하지 못했습니다.');
      }
      if (action === 'create') setEmail('');
      setNotice(action === 'cancel' ? '초대를 취소했습니다.' : '초대 메일을 발송했습니다.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '초대 요청을 처리하지 못했습니다.');
      // 발송 실패 때에도 서버에 초대가 남을 수 있으므로 상태를 다시 확인합니다.
      await load().catch(() => {});
    } finally { setBusy(false); }
  };

  return <section aria-label="이메일 초대 관리" className="rounded-lg border border-surface-700 p-4 space-y-3">
    <h3 className="font-semibold">이메일로 멤버 초대</h3>
    <p className="text-sm text-gray-400">초대받은 사람이 메일 링크에서 이름, 아이디와 비밀번호를 직접 설정합니다.</p>
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void run('create'); }}>
      <input aria-label="초대할 이메일" type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="member@example.com" className="flex-1 min-w-48 rounded bg-surface-800 border border-surface-600 px-3 py-2" />
      <select aria-label="초대 멤버 권한" value={role} onChange={event => setRole(event.target.value)} className="rounded bg-surface-800 px-3 py-2">{roles.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <button type="submit" disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{busy ? '처리 중…' : '초대 메일 보내기'}</button>
    </form>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-green-400">{notice}</p>}
    <ul className="space-y-2">{rows.map(row => {
      const expired = row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now();
      const status = expired ? '만료' : ({ pending: '수락 대기', accepted: '수락 완료', cancelled: '취소됨' }[row.status] || row.status);
      return <li key={row.id} className="flex flex-wrap items-center gap-3 text-sm border-t border-surface-700 pt-2">
        <span>{row.email}</span><span className="text-gray-400">{row.role} · {status}</span>
        {row.status === 'pending' && <><button disabled={busy} onClick={() => void run('resend', row.id)} className="min-h-11 px-3">재발송</button><button disabled={busy} onClick={async () => { if (await confirm({ title: '초대 취소', message: `${row.email} 초대를 취소할까요?`, confirmLabel: '초대 취소' })) void run('cancel', row.id); }} className="min-h-11 px-3 text-red-400">취소</button></>}
      </li>;
    })}</ul>
  </section>;
}
