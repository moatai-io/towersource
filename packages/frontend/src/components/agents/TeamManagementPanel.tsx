import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyTeamIntent, getManagedTeam, listManagedTeams, previewTeamCommand, TeamApiError,
  type ManagedTeam, type TeamCommand, type TeamDetail, type TeamIntent,
} from './team-management-api';

export interface TeamManagementPanelProps {
  onApplied?: () => void;
  /** Directory data belongs to the parent. No guessed user/project API queries. */
  users?: ReadonlyArray<{ id: number; username: string; displayName?: string }>;
  projects?: ReadonlyArray<{ id: string; name: string }>;
}
type Phase = 'loading' | 'ready' | 'error' | 'inactive' | 'forbidden';
const control = 'min-h-11 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50';
const button = 'min-h-11 rounded-lg border border-surface-700 px-4 py-2 text-sm font-semibold text-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:opacity-50';

/** Admin presentation is owned by AITeamHome; the server remains the authority. */
export function TeamManagementPanel({ users, projects, onApplied }: TeamManagementPanelProps) {
  const { t } = useTranslation('layout');
  const tr = (key: string, fallback: string) => t(`teamManagement.${key}`, { defaultValue: fallback });
  const prefix = useId();
  const [phase, setPhase] = useState<Phase>('loading');
  const [teams, setTeams] = useState<ManagedTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [kind, setKind] = useState<TeamCommand['kind']>('create');
  const [name, setName] = useState('');
  const [newTeamId, setNewTeamId] = useState<string>(() => crypto.randomUUID());
  const [userId, setUserId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [detailPhase, setDetailPhase] = useState<Phase>('ready');
  const [reload, setReload] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const [intent, setIntent] = useState<TeamIntent | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const revision = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const applying = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);

  function message(caught: unknown) {
    if (!(caught instanceof TeamApiError)) return tr('networkError', '팀 관리 서버에 연결할 수 없습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
    if (caught.code === 'TEAM_MANAGEMENT_INACTIVE' || (caught.status === 404 && phase === 'loading')) return tr('inactive', '팀 관리 기능이 비활성화되어 있습니다. 설정이나 파일 공유가 완료된 상태가 아닙니다.');
    if (caught.status === 403) return tr('forbidden', '현재 권한으로는 이 변경을 적용할 수 없습니다. 관리자 권한과 대상 사용자의 이용 자격을 확인해 주세요.');
    if (caught.status === 410) return tr('expired', '미리보기가 만료되었습니다. 다시 미리보기를 진행해 주세요.');
    if (caught.status === 409) return tr('conflict', '팀 상태가 달라졌거나 요청이 충돌했습니다. 현재 구성을 확인하고 다시 미리보기를 진행해 주세요.');
    if (caught.code === 'TEAM_MANAGEMENT_RESPONSE_INVALID') return tr('invalidResponse', '서버 응답을 확인할 수 없습니다. 적용 여부를 단정할 수 없으므로 현재 구성을 다시 조회하고 검토해 주세요.');
    if (caught.status === 404) return tr('notFound', '요청한 팀 또는 승인 내역을 찾을 수 없습니다. 다시 조회하고 미리보기를 진행해 주세요.');
    return tr('unavailable', '팀 관리 요청을 처리하지 못했습니다. 기능 또는 실행 환경이 준비되지 않았을 수 있습니다. 설정 적용이나 파일 공유 완료로 간주하지 마세요.');
  }
  function reject(caught: unknown) {
    revision.current++; operation.current?.abort(); setBusy(null);
    setError(message(caught)); setIntent(null);
    if (caught instanceof TeamApiError) {
      if (caught.code === 'TEAM_MANAGEMENT_INACTIVE') setPhase('inactive');
      if (['TEAM_MANAGEMENT_ADMIN_REQUIRED', 'TEAM_MANAGEMENT_AUTH_SCOPE_DENIED', 'TEAM_MANAGEMENT_ACTOR_REQUIRED'].includes(caught.code)) setPhase('forbidden');
    }
  }
  function invalidate() {
    revision.current++; operation.current?.abort(); setBusy(null); setIntent(null); setError(''); setSuccess('');
  }
  useEffect(() => () => { revision.current++; operation.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading'); setError('');
    listManagedTeams(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setTeams(result); setPhase('ready');
      setTeamId(current => result.some(team => team.id === current) ? current : '');
    }).catch(caught => {
      if (controller.signal.aborted) return;
      setError(message(caught));
      setPhase(caught instanceof TeamApiError && caught.status === 404 ? 'inactive' : caught instanceof TeamApiError && caught.status === 403 ? 'forbidden' : 'error');
    });
    return () => controller.abort();
    // Reload is explicit; edits never refetch the list or invalidate an active apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    if (!teamId) { setDetailPhase('ready'); return () => controller.abort(); }
    setDetailPhase('loading');
    getManagedTeam(teamId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setDetail(result); setDetailPhase('ready');
    }).catch(caught => {
      if (controller.signal.aborted) return;
      setDetailPhase('error'); reject(caught);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, detailReload]);
  // This is an inline review region, not a modal. Focus its heading as soon as
  // it is committed so keyboard users can review the result before interacting.
  useLayoutEffect(() => {
    if (intent) reviewHeading.current?.focus();
  }, [intent]);
  useEffect(() => {
    if (!intent) return;
    const expire = () => { revision.current++; operation.current?.abort(); setIntent(null); setBusy(null); setError(tr('expired', '미리보기가 만료되었습니다. 다시 미리보기를 진행해 주세요.')); };
    const remaining = Date.parse(intent.expiresAt) - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  const validText = (value: string) => !!value.trim() && value.trim().length <= 200;
  const command: TeamCommand | null = kind === 'create'
    ? validText(name) && validText(newTeamId) ? { kind, teamId: newTeamId.trim(), name: name.trim() } : null
    : !teamId || detailPhase !== 'ready' ? null : kind === 'assign'
      ? validText(projectId) ? { kind, teamId, projectId: projectId.trim() } : null
      : Number.isSafeInteger(Number(userId)) && Number(userId) > 0 ? { kind, teamId, userId: Number(userId) } : null;
  async function preview(event: React.FormEvent) {
    event.preventDefault();
    if (!command || busy || applying.current) return;
    invalidate(); const currentRevision = revision.current;
    const controller = new AbortController(); operation.current = controller; setBusy('preview');
    try {
      const result = await previewTeamCommand(command, controller.signal);
      if (controller.signal.aborted || revision.current !== currentRevision) return;
      if (Date.parse(result.expiresAt) <= Date.now()) throw new TeamApiError(410, 'TEAM_MANAGEMENT_INTENT_EXPIRED');
      setIntent(result);
    } catch (caught) { if (!controller.signal.aborted && revision.current === currentRevision) reject(caught); }
    finally { if (revision.current === currentRevision) setBusy(null); }
  }
  async function apply() {
    if (!intent || busy || applying.current) return;
    if (Date.parse(intent.expiresAt) <= Date.now()) { invalidate(); setError(tr('expired', '미리보기가 만료되었습니다. 다시 미리보기를 진행해 주세요.')); return; }
    applying.current = true; setBusy('apply'); setError('');
    // Once sent, expiry must not abort observation of a committed result. Server checks expiry atomically.
    const confirmedIntent = intent; setIntent(null);
    const controller = new AbortController(); operation.current = controller;
    const currentRevision = revision.current;
    try {
      const result = await applyTeamIntent(confirmedIntent, controller.signal);
      onApplied?.();
      if (controller.signal.aborted || revision.current !== currentRevision) return;
      setSuccess(result.changed ? tr('applied', '팀 설정에 반영했습니다. 파일 공유·실행 환경의 실제 동작 완료를 보장하지는 않습니다.') : tr('unchanged', '팀 설정은 이미 같은 상태입니다. 추가 변경은 없으며 파일 공유·실행 환경의 실제 동작은 별도 확인이 필요합니다.'));
      setReload(value => value + 1); setDetailReload(value => value + 1);
    } catch (caught) { if (!controller.signal.aborted && revision.current === currentRevision) reject(caught); }
    finally { applying.current = false; if (revision.current === currentRevision) setBusy(null); }
  }
  const labels = { create: tr('create', '팀 생성'), invite: tr('invite', '사람 초대'), revoke: tr('revoke', '이용권 철회'), assign: tr('assign', 'Agent 배정') };
  const personName = (id: number) => { const person = users?.find(user => user.id === id); return person ? `${person.displayName || person.username} (#${id})` : `#${id}`; };
  const agentName = (id: string) => `${projects?.find(project => project.id === id)?.name || tr('agent', 'Agent')} (${id})`;
  return <section aria-labelledby={`${prefix}-heading`} className="min-w-0 space-y-5 rounded-xl border border-surface-800 bg-surface-900/70 p-4 text-surface-200 sm:p-6 [word-break:keep-all] [overflow-wrap:anywhere]">
    <header><div className="flex flex-wrap items-center justify-between gap-3"><h2 id={`${prefix}-heading`} className="text-lg font-semibold text-surface-100">{tr('title', '팀 관리')}</h2>
      {phase === 'ready' && <button type="button" className={button} disabled={busy !== null} onClick={() => { invalidate(); setReload(value => value + 1); setDetailReload(value => value + 1); }}>{tr('refresh', '현재 구성 새로고침')}</button>}</div>
      <p className="mt-2 max-w-prose text-sm leading-6 text-surface-400">{tr('boundary', '팀 파일은 함께 사용할 수 있지만 대화는 자동 공유되지 않습니다. 이용권을 철회하면 해당 팀 Agent의 자기 대화도 열람·재개할 수 없습니다. 이미 전달된 외부 스냅샷은 자동 회수되지 않습니다.')}</p>
      <p className="mt-2 max-w-prose text-sm leading-6 text-surface-400">{tr('executorBoundary', '팀 파일 공유 실행기(executor)의 지원·준비 여부는 이 화면에서 확인하지 않습니다. 미지원 환경에서는 파일 공유가 동작하지 않습니다.')}</p></header>
    {phase === 'loading' && <p role="status">{tr('loading', '팀 목록을 불러오는 중입니다.')}</p>}
    {error && <p role="alert" className="tone-warning tone-card rounded-lg border p-3 text-sm leading-6">{error}</p>}
    {success && <p role="status" className="tone-success tone-card rounded-lg border p-3 text-sm leading-6">{success}</p>}
    {phase !== 'loading' && phase !== 'ready' && <button type="button" className={button} onClick={() => { invalidate(); setReload(value => value + 1); }}>{tr('retry', '다시 시도')}</button>}
    {phase === 'ready' && <>
      {!teams.length && <p className="text-sm text-surface-400">{tr('empty', '아직 등록된 팀이 없습니다.')}</p>}
      <form onSubmit={preview} className="space-y-4" aria-label={tr('form', '팀 변경 입력')}>
        <fieldset disabled={busy === 'apply'} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <legend className="sr-only">{tr('edit', '변경 대상과 작업')}</legend>
          <label className="min-w-0 space-y-2 text-sm"><span>{tr('team', '팀 선택')}</span><select className={control} value={teamId} onChange={event => { invalidate(); setTeamId(event.target.value); setKind(event.target.value ? 'invite' : 'create'); }}>
            <option value="">{tr('newTeam', '새 팀 만들기')}</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name} ({team.id}) · {team.state}</option>)}
          </select></label>
          <label className="min-w-0 space-y-2 text-sm"><span>{tr('kind', '변경 종류')}</span><select className={control} value={kind} onChange={event => { invalidate(); setKind(event.target.value as TeamCommand['kind']); }}>
            {Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={value !== 'create' && !teamId}>{label}</option>)}
          </select></label>
          {kind === 'create' ? <>
            <label className="min-w-0 space-y-2 text-sm"><span>{tr('teamName', '팀 이름')}</span><input className={control} required maxLength={200} value={name} onChange={event => { invalidate(); setName(event.target.value); }} /></label>
            <label className="min-w-0 space-y-2 text-sm"><span>{tr('newId', '새 팀 ID')}</span><input aria-label={tr('newId', '새 팀 ID')} className={control} required maxLength={200} value={newTeamId} onChange={event => { invalidate(); setNewTeamId(event.target.value); }} /><span className="block text-xs leading-5 text-surface-400">{tr('uniqueId', '고유 ID가 자동 생성됩니다. 기존 팀 ID와 중복되지 않아야 합니다.')}</span></label>
          </> : kind === 'assign' ? <label className="min-w-0 space-y-2 text-sm sm:col-span-2"><span>{tr('targetAgent', '대상 Agent')}</span>
            {projects ? <select className={control} required value={projectId} onChange={event => { invalidate(); setProjectId(event.target.value); }}><option value="">{tr('chooseAgent', 'Agent를 선택하세요')}</option>{projects.map(project => <option key={project.id} value={project.id}>{agentName(project.id)}</option>)}</select> : <input className={control} required placeholder={tr('projectId', 'Agent의 Project ID')} maxLength={200} value={projectId} onChange={event => { invalidate(); setProjectId(event.target.value); }} />}
          </label> : <label className="min-w-0 space-y-2 text-sm sm:col-span-2"><span>{tr('targetUser', '대상 사용자')}</span>
            {users ? <select className={control} required value={userId} onChange={event => { invalidate(); setUserId(event.target.value); }}><option value="">{tr('chooseUser', '사용자를 선택하세요')}</option>{users.map(user => <option key={user.id} value={user.id}>{personName(user.id)}</option>)}</select> : <input className={control} required type="number" min={1} step={1} placeholder={tr('userId', '사용자 논리 ID (양의 정수)')} value={userId} onChange={event => { invalidate(); setUserId(event.target.value); }} />}
          </label>}
        </fieldset>
        {teamId && <div aria-label={tr('composition', '현재 팀 구성')} className="border-y border-surface-800 py-3 text-sm leading-6">
          {detailPhase === 'loading' ? <p role="status">{tr('detailLoading', '현재 구성을 불러오는 중입니다.')}</p> : detailPhase === 'error' ? <button type="button" className={button} onClick={() => { invalidate(); setDetailReload(value => value + 1); }}>{tr('detailRetry', '구성원 다시 불러오기')}</button> : detail && <>
            <p>{detail.team.name} · {detail.team.state} · {tr('version', '버전')} {detail.team.version}</p>
            <p className="mt-2 font-semibold">{tr('members', '사람')}</p>{detail.members.length ? <ul className="list-inside list-disc">{detail.members.map(member => <li key={member.userId}>{personName(member.userId)} · {member.state}</li>)}</ul> : <p className="text-surface-400">{tr('noMembers', '등록된 구성원이 없습니다.')}</p>}
            <p className="mt-2 font-semibold">{tr('agents', 'Agent')}</p>{detail.agents.length ? <ul className="list-inside list-disc">{detail.agents.map(agent => <li key={agent.projectId}>{agentName(agent.projectId)}</li>)}</ul> : <p className="text-surface-400">{tr('noAgents', '배정된 Agent가 없습니다.')}</p>}
          </>}
        </div>}
        <button ref={previewButton} type="submit" disabled={!command || busy !== null} className={`${button} tone-accent tone-action`}>{busy === 'preview' ? tr('previewing', '미리보기를 준비하는 중입니다…') : tr('preview', '변경 미리보기')}</button>
      </form>
      {intent && <section aria-labelledby={`${prefix}-review`} className="space-y-4 border-t border-surface-700 pt-5">
        <h3 ref={reviewHeading} tabIndex={-1} id={`${prefix}-review`} className="text-base font-semibold text-surface-100">{tr('review', '변경 검토')}</h3>
        <dl className="grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-surface-400">{tr('command', '명령')}</dt><dd>{labels[intent.preview.command.kind]} ({intent.preview.command.kind})</dd>
          <dt className="text-surface-400">{tr('targetTeam', '대상 팀 ID')}</dt><dd>{intent.preview.command.teamId}</dd>
          {'name' in intent.preview.command && <><dt>{tr('teamName', '팀 이름')}</dt><dd>{intent.preview.command.name}</dd></>}
          {'userId' in intent.preview.command && <><dt>{tr('targetUser', '대상 사용자')}</dt><dd>{personName(intent.preview.command.userId)}</dd></>}
          {'projectId' in intent.preview.command && <><dt>{tr('targetAgent', '대상 Agent')}</dt><dd>{agentName(intent.preview.command.projectId)}</dd></>}
          <dt className="text-surface-400">{tr('actor', '승인 요청 사용자 ID')}</dt><dd>{intent.preview.actorUserId}</dd>
          <dt className="text-surface-400">{tr('currentVersion', '현재 팀 버전')}</dt><dd>{intent.preview.expected.teamVersion ?? tr('none', '없음')}</dd>
          <dt className="text-surface-400">{tr('currentState', '현재 팀 상태')}</dt><dd>{intent.preview.expected.teamState ?? tr('none', '없음')}</dd>
          <dt className="text-surface-400">{tr('memberState', '현재 사용자 이용 상태')}</dt><dd>{intent.preview.expected.memberState ?? tr('none', '없음')}</dd>
          <dt className="text-surface-400">{tr('assignment', '현재 Agent 소속 팀')}</dt><dd>{intent.preview.expected.assignedTeamId ?? tr('none', '없음')}</dd>
          <dt className="text-surface-400">{tr('workspaces', '관련 작업 폴더 ID')}</dt><dd>{intent.preview.expected.workspaceIds.join(', ') || tr('none', '없음')}</dd>
          <dt className="text-surface-400">{tr('expires', '승인 만료')}</dt><dd><time dateTime={intent.expiresAt}>{new Date(intent.expiresAt).toLocaleString()}</time></dd>
          <dt className="text-surface-400">{tr('hash', '검토 해시')}</dt><dd className="min-w-0 break-all font-mono text-xs leading-6">{intent.proposalHash}</dd>
          <dt className="text-surface-400">{tr('intent', '승인 내역 ID')}</dt><dd className="min-w-0 break-all font-mono text-xs leading-6">{intent.intentId}</dd>
        </dl>
        <div className="tone-warning tone-card space-y-2 rounded-lg border p-3 text-sm leading-6">
          <p className="font-semibold">{tr('warnings', '영향과 경고')}</p>
          <p>{tr('unknownImpact', '영향을 받는 Agent·파일·본인 대화의 전체 개수는 미확인입니다. 0개를 의미하지 않습니다.')}</p>
          {intent.preview.warnings.length ? <ul className="list-inside list-disc">{intent.preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p>{tr('noWarnings', '서버의 추가 경고가 없습니다. 위의 공유 경계는 그대로 적용됩니다.')}</p>}
          {intent.impact && <><p>{intent.impact.note}</p><p>{intent.impact.warning}</p></>}
        </div>
        <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void apply()} disabled={busy !== null} className={`${button} tone-accent tone-action`}>{tr('approve', '승인하고 적용')}</button>
          <button type="button" className={button} disabled={busy === 'apply'} onClick={() => { invalidate(); previewButton.current?.focus(); }}>{tr('cancel', '취소')}</button></div>
      </section>}
      {busy === 'apply' && <p role="status">{tr('applying', '승인한 팀 변경을 적용하는 중입니다. 중복 요청하지 마세요.')}</p>}
    </>}
  </section>;
}
