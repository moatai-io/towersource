import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDirectoryVisibility as Visibility, Project } from '@tower/shared';
import { getCurrentRole } from '../../utils/auth';

/** Explicit disclosure review, kept separate from Agent access/membership. */
export function AgentDirectoryVisibility({ project }: { project: Project }) {
  const { t } = useTranslation('layout');
  const [expanded, setExpanded] = React.useState(false);
  const [current, setCurrent] = React.useState<Visibility | null>(null);
  const [draft, setDraft] = React.useState<Visibility>('unlisted');
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const role = getCurrentRole();
  const mayManage = role === 'admin' || role === 'operator' || (role === 'member' && (project as Project & { membershipRole?: string }).membershipRole === 'owner');
  const endpoint = `/api/agent-directory/${encodeURIComponent(project.id)}/visibility`;
  React.useEffect(() => {
    if (!expanded || !mayManage) return;
    const controller = new AbortController();
    setBusy(true); setError(false); setCurrent(null); setConfirmed(false);
    fetch(endpoint, { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (!controller.signal.aborted) { setCurrent(data.visibility); setDraft(data.visibility); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [expanded, mayManage, endpoint]);
  async function save() {
    if (!confirmed || busy || draft === current) return;
    setBusy(true); setError(false);
    try {
      const response = await fetch(endpoint, { method: 'PATCH', headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: draft, confirmed: true }) });
      if (!response.ok) throw new Error('unavailable');
      setCurrent((await response.json()).visibility); setConfirmed(false);
      window.dispatchEvent(new CustomEvent('tower-agent-directory-changed'));
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  if (!mayManage || project.archived) return null;
  return <div className="mt-3 border-t border-surface-800 pt-3 text-xs text-surface-400">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="rounded py-1 text-left focus-visible:ring-2 focus-visible:ring-primary-400">{t('agentDirectory.visibility.title')}</button>
    {expanded && <div className="mt-2 space-y-2">
      {busy && <p role="status">{t('agentDirectory.loading')}</p>}
      {current && <>
        <p className="leading-5">{t('agentDirectory.visibility.description')}</p>
        <label className="block">{t('agentDirectory.visibility.current')}: {t(`agentDirectory.visibility.${current}`)}
          <select disabled={busy} value={draft} onChange={event => { setDraft(event.target.value as Visibility); setConfirmed(false); }} aria-label={t('agentDirectory.visibility.title')} className="mt-2 block w-full rounded border border-surface-700 bg-surface-900 px-2 py-2 text-surface-200">
            {(['listed', 'unlisted', 'confidential'] as const).map(value => <option key={value} value={value}>{t(`agentDirectory.visibility.${value}`)}</option>)}
          </select>
        </label>
        {draft !== current && <>
          <p className="leading-5 text-surface-300">{t(draft === 'listed' ? 'agentDirectory.visibility.publishWarning' : 'agentDirectory.visibility.hideWarning')}</p>
          <label className="flex items-start gap-2 leading-5"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />{t('agentDirectory.visibility.confirm')}</label>
          <button type="button" onClick={() => void save()} disabled={!confirmed || busy} className="rounded border border-surface-600 px-3 py-2 text-surface-200 disabled:opacity-50">{t('agentDirectory.visibility.save')}</button>
        </>}
      </>}
      {error && <p role="alert">{t('agentDirectory.visibility.error')}</p>}
    </div>}
  </div>;
}
