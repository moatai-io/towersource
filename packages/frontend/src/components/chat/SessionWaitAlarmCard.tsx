import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { serverNowMs } from '../../utils/server-clock';
import { useSessionWaitAlarm } from './useSessionWaitAlarm';

export function remainingWaitMinutes(wakeAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(wakeAt) - now) / 60_000));
}

function localDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A quiet saved-alarm companion to the conversation, not a running-tool indicator. */
export function SessionWaitAlarmCard({ sessionId, isStreaming }: { sessionId: string; isStreaming: boolean }) {
  const { t, i18n } = useTranslation('chat');
  const { alarm, canManage, error, busy, refresh, act } = useSessionWaitAlarm(sessionId, isStreaming);
  const [now, setNow] = useState(serverNowMs);
  const [editing, setEditing] = useState(false);
  const [wakeInput, setWakeInput] = useState('');
  const [invalidTime, setInvalidTime] = useState(false);
  const pending = alarm?.status === 'pending';

  useEffect(() => {
    if (!pending) return;
    const tick = () => { if (document.visibilityState !== 'hidden') setNow(serverNowMs()); };
    tick();
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [pending]);

  useEffect(() => { setEditing(false); setInvalidTime(false); }, [alarm?.id, alarm?.version, sessionId]);

  if (!pending && !error) return null;
  const minutes = alarm ? remainingWaitMinutes(alarm.wakeAt, now) : 0;
  const remaining = minutes >= 60
    ? t('waitAlarm.hoursRemaining', { hours: Math.floor(minutes / 60), minutes: minutes % 60, defaultValue: '{{hours}}시간 {{minutes}}분 남음' })
    : t('waitAlarm.minutesRemaining', { minutes, defaultValue: '{{minutes}}분 남음' });
  const wakeLabel = alarm ? new Intl.DateTimeFormat(i18n.language, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(alarm.wakeAt)) : '';
  const buttonClass = 'rounded px-2 py-1 text-xs text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div data-testid="floating-wait-alarm" className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-end bg-transparent px-3 py-1 sm:px-5">
      <details className="pointer-events-auto group relative min-w-0 max-w-full">
        <summary className="cursor-pointer list-none rounded-lg border border-surface-700/70 bg-surface-50 dark:bg-surface-900 px-3 py-1 text-xs text-surface-500 dark:text-surface-300">
          {t('waitAlarm.title', { defaultValue: '대기 알람' })} · {error === 'load' ? t('waitAlarm.loadFailed', { defaultValue: '알람 상태를 불러오지 못했습니다.' }) : remaining}
        </summary>
      <aside aria-label={t('waitAlarm.title', { defaultValue: '대기 알람' })} className="absolute right-0 top-full z-40 mt-1 max-h-[min(60vh,28rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-surface-200 bg-surface-50 px-3 py-2 dark:border-surface-700 dark:bg-surface-900" aria-busy={busy}>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-surface-500 dark:text-surface-400">
            <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="13" r="8" /><path strokeLinecap="round" d="M12 9v4l3 2M5 3 2 6m17-3 3 3" /></svg>
            {t('waitAlarm.title', { defaultValue: '대기 알람' })}
          </span>
          {pending && !error && <span role="timer" aria-live="off" className="text-xs tabular-nums text-surface-700 dark:text-surface-200">{minutes > 0 ? remaining : t('waitAlarm.due', { defaultValue: '재개를 기다리는 중' })}</span>}
        </div>
        {pending && alarm && <>
          <p className="mt-1 break-words text-sm text-surface-700 dark:text-surface-200">{alarm.reason}</p>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            <time dateTime={alarm.wakeAt}>{wakeLabel}</time>
            {minutes === 0 && !error && <span className="ml-1">· {t('waitAlarm.whenIdle', { defaultValue: '예정 시각이 지났습니다. 아직 자동 재개되지 않았습니다.' })}</span>}
          </p>
        </>}
        {(error || invalidTime) && <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t(`waitAlarm.errors.${invalidTime ? 'invalid' : error}`, { defaultValue: '알람 상태를 확인하지 못했습니다. 다시 확인해 주세요.' })}</p>}
        {editing && pending && canManage ? (
          <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (event) => {
            event.preventDefault();
            const wakeAt = new Date(wakeInput).getTime();
            const currentNow = serverNowMs();
            if (!Number.isFinite(wakeAt) || wakeAt <= currentNow || wakeAt > currentNow + 30 * 24 * 60 * 60 * 1000) { setInvalidTime(true); return; }
            setInvalidTime(false);
            if (await act('reschedule', new Date(wakeAt).toISOString())) setEditing(false);
          }}>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-surface-600 dark:text-surface-300">
              {t('waitAlarm.wakeTime', { defaultValue: '재개 시각 (현재 시간대)' })}
              <input type="datetime-local" required value={wakeInput} onChange={(event) => { setWakeInput(event.target.value); setInvalidTime(false); }} min={localDateInput(now + 60_000)} max={localDateInput(now + 30 * 24 * 60 * 60 * 1000)} disabled={busy} className="min-w-0 rounded border border-surface-300 bg-white px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-surface-600 dark:bg-surface-800" />
            </label>
            <button type="submit" disabled={busy || error === 'load'} className={buttonClass}>{t('waitAlarm.save', { defaultValue: '변경 저장' })}</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setInvalidTime(false); }} className={buttonClass}>{t('waitAlarm.close', { defaultValue: '닫기' })}</button>
          </form>
        ) : <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1">
          {pending && canManage && <>
            <button type="button" disabled={busy || error === 'load'} onClick={() => { void act('now'); }} className={buttonClass}>{t('waitAlarm.resumeNow', { defaultValue: '지금 이어가기' })}</button>
            <button type="button" disabled={busy || error === 'load'} onClick={() => { setWakeInput(localDateInput(Math.max(Date.parse(alarm!.wakeAt), serverNowMs() + 60_000))); setEditing(true); }} className={buttonClass}>{t('waitAlarm.changeTime', { defaultValue: '시간 변경' })}</button>
            <button type="button" disabled={busy || error === 'load'} onClick={() => { void act('cancel'); }} className={buttonClass}>{t('waitAlarm.cancel', { defaultValue: '알람 취소' })}</button>
          </>}
          {error && <button type="button" disabled={busy} onClick={() => { void refresh(); }} className={buttonClass}>{t('waitAlarm.refresh', { defaultValue: '다시 확인' })}</button>}
        </div>}
      </aside>
      </details>
    </div>
  );
}
