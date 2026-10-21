import { SecretariatChat } from './SecretariatChat';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { requestBriefing } from './secretariat-api';
import { useSecretariat } from './use-secretariat';

const secondaryButton = 'rounded-lg border border-surface-700 px-3 py-2 text-sm text-surface-200 hover:bg-surface-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500';

export function SecretariatPanel() {
  const { t } = useTranslation('layout');
  const { snapshot, loading, loadError, operation, operationError, refresh, setEnabled, markRead } = useSecretariat();
  const [briefingResult,setBriefingResult] = useState<{id:string;sequence:number}|null>(null);
  const [briefing, setBriefing] = useState(false);
  const [briefingMessage, setBriefingMessage] = useState('');
  const briefingAbort = useRef<AbortController | null>(null);
  useEffect(() => () => briefingAbort.current?.abort(), []);
  const runBriefing = async () => {
    if (briefingAbort.current) return;
    const controller = new AbortController(); briefingAbort.current = controller;
    setBriefing(true); setBriefingMessage('진행 상황을 살펴보고 있어요.');
    try {
      const result = await requestBriefing(controller.signal);
      if (controller.signal.aborted) return;
      await refresh();
      if (result.proposalId) { setBriefingResult({id:result.proposalId,sequence:Date.now()}); setBriefingMessage(result.status==='existing'?'아직 확인하지 않은 제안을 열었어요.':'최근 대화를 살펴보고 새 브리핑을 준비했어요.'); }
      else setBriefingMessage(result.status === 'failed' ? '브리핑을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.' : '지금 새 제안이 없거나, 점검 중·재요청 대기 상태입니다. 잠시 후 다시 확인해 주세요.');
    } catch { if (!controller.signal.aborted) setBriefingMessage('브리핑을 불러오지 못했습니다. 다시 시도해 주세요.'); }
    finally { if (!controller.signal.aborted) setBriefing(false); briefingAbort.current = null; }
  };
  const unread = snapshot?.proposals.filter((proposal) => !proposal.readAt).length ?? 0;
  const disabled = loading || !!operation || !snapshot || loadError;
  const paused = snapshot?.enabled && (!!snapshot.pausedReason || unread > 0);

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-900 text-surface-200" aria-label="비서실" data-testid="secretariat-panel">
      <div className="relative flex shrink-0 items-center justify-between gap-3 border-b border-surface-800 px-5 py-2">
        <span className="text-xs text-surface-400">{unread ? `확인할 이야기 ${unread}개` : '이전 이야기부터 이어가세요.'}</span>
        <details className="group">
          <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm text-surface-400 focus-visible:outline">비서실 설정</summary>
          <div className="absolute right-3 top-full z-20 w-72 space-y-3 rounded-xl border border-surface-700 bg-surface-900 p-4 shadow-xl">
            <div className="flex items-center justify-between gap-3"><span>먼저 챙겨주기</span>
              <button role="switch" aria-label={t('secretariatToggle')} aria-checked={snapshot?.enabled ?? false} disabled={disabled} onClick={()=>void setEnabled(!snapshot?.enabled)} className="min-h-11 rounded-lg border border-surface-700 px-3">{t(snapshot?.enabled?'secretariatOn':'secretariatOff')}</button>
            </div>
            <p className="text-xs leading-relaxed text-surface-400">{t('secretariatPolicy')}</p>
            <p className="text-xs text-surface-400">{paused?'미열람 제안이 있어 새 점검을 쉬고 있어요.':t(snapshot?.enabled?'secretariatActiveDescription':'secretariatDisabledDescription')}</p>
            <button className={secondaryButton} onClick={()=>void refresh()}>새로고침</button>
          </div>
        </details>
      </div>
      {(loadError || operationError) && <div role="alert" className="shrink-0 px-5 py-2 text-sm text-red-400">설정을 확인하지 못했습니다. <button onClick={()=>void refresh()}>다시 시도</button></div>}
      <SecretariatChat briefingResult={briefingResult} briefing={briefing} briefingMessage={briefingMessage} onBriefing={()=>void runBriefing()} onRead={markRead} />
    </section>
  );
}
