import React from 'react';
import { toastError, toastQuiet, toastSuccess } from '../../utils/toast';
import {
  getNotificationPermission,
  getVapidInfo,
  isPushSupported,
  sendTestPush,
  subscribeToWebPush,
  unsubscribeFromWebPush,
} from '../../lib/push-notifications';

const API = import.meta.env.VITE_API_URL || '';

function getToken() {
  return localStorage.getItem('token') || '';
}

type EventPreference = {
  eventType: string;
  label?: string;
  description?: string;
  inApp: boolean;
  toast: boolean;
  webPush: boolean;
  minPriority?: string;
};

type ProjectPreference = {
  projectId: string;
  projectName: string;
  enabled: boolean;
  inApp: boolean | null;
  toast: boolean | null;
  webPush: boolean | null;
  mutedUntil: string | null;
};

type NotificationPreferences = {
  global: {
    inAppEnabled: boolean;
    toastEnabled: boolean;
    webPushEnabled: boolean;
    quietHoursEnabled?: boolean;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    timezone?: string | null;
  };
  events: EventPreference[];
  projects: ProjectPreference[];
};

type GroupId = 'direct' | 'longTaskDone' | 'needsAction' | 'aiDone' | 'updates';

type GroupConfig = {
  id: GroupId;
  title: string;
  desc: string;
  events: string[];
  on: Pick<EventPreference, 'inApp' | 'toast' | 'webPush'>;
  off: Pick<EventPreference, 'inApp' | 'toast' | 'webPush'>;
};

const groups: GroupConfig[] = [
  {
    id: 'direct',
    title: '나를 부른 알림',
    desc: '@멘션, 직접 확인해야 하는 메시지',
    events: ['message.mention'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'longTaskDone',
    title: '내가 시작한 긴 작업 완료',
    desc: '리서치, 파일 변환, 긴 분석 같은 태스크 완료',
    events: ['task.completed'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'needsAction',
    title: '실패 알림',
    desc: '태스크 실패와 자동화 실패',
    events: ['task.failed', 'automation.failed'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'aiDone',
    title: '일반 AI 완료',
    desc: '세션 완료, 병렬 세션 완료, AI 선제 메시지',
    events: ['session.completed', 'spawn.completed', 'proactive.message'],
    on: { inApp: true, toast: true, webPush: false },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'updates',
    title: '일반 작업 업데이트',
    desc: '태스크 성공, 자동화 성공, 일반 채널 메시지',
    events: ['automation.completed', 'message.room', 'system.announcement'],
    on: { inApp: true, toast: false, webPush: false },
    off: { inApp: false, toast: false, webPush: false },
  },
];

const globalChannels = [
  { key: 'inAppEnabled', label: '알림 센터', desc: '벨과 목록에 저장' },
  { key: 'toastEnabled', label: '앱 안 토스트', desc: '열린 탭에서 짧게 표시' },
  { key: 'webPushEnabled', label: '브라우저/PWA', desc: 'Tower를 보지 않아도 멘션·실패·긴 작업 완료만 OS 알림' },
] as const;

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/60 ${
        checked ? 'tone-success tone-bg' : 'bg-surface-700'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:brightness-110'}`}
      aria-pressed={checked}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function NotificationSettingsPanel() {
  const [prefs, setPrefs] = React.useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [pushConfigured, setPushConfigured] = React.useState<boolean | null>(null);
  const [pushPermission, setPushPermission] = React.useState<NotificationPermission | 'unsupported'>(
    typeof window === 'undefined' ? 'unsupported' : getNotificationPermission(),
  );
  const [pushBusy, setPushBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API}/api/notification-preferences`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => { if (!cancelled) setPrefs(data); })
      .catch((err) => { if (!cancelled) setError(err.message || '알림 설정을 불러오지 못했습니다.'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    if (isPushSupported()) {
      getVapidInfo()
        .then((info) => { if (!cancelled) setPushConfigured(info.configured); })
        .catch(() => { if (!cancelled) setPushConfigured(false); });
    } else {
      setPushConfigured(false);
    }
    return () => { cancelled = true; };
  }, []);

  const save = React.useCallback(async (next: NotificationPreferences) => {
    setPrefs(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/notification-preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPrefs(data);
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(err?.message || '알림 설정 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }, []);

  const updateGlobal = (key: keyof NotificationPreferences['global'], value: boolean) => {
    if (!prefs) return;
    void save({ ...prefs, global: { ...prefs.global, [key]: value } });
  };

  const handlePushToggle = async (next: boolean) => {
    if (!prefs) return;
    setPushBusy(true);
    try {
      if (next) {
        await subscribeToWebPush();
        setPushPermission(getNotificationPermission());
        const recommendedPushEvents = new Set(['message.mention', 'task.failed', 'automation.failed', 'task.completed']);
        await save({
          ...prefs,
          global: { ...prefs.global, webPushEnabled: true },
          events: prefs.events.map((event) => recommendedPushEvents.has(event.eventType)
            ? { ...event, webPush: true }
            : { ...event, webPush: false }),
        });
        toastSuccess('브라우저 알림이 켜졌습니다');
      } else {
        // Turning off should never be blocked by browser/SW cleanup. Persist the
        // Tower preference first, then best-effort unsubscribe this browser.
        await save({ ...prefs, global: { ...prefs.global, webPushEnabled: false } });
        await unsubscribeFromWebPush().catch(() => {});
        setPushPermission(getNotificationPermission());
        toastQuiet('브라우저 알림을 껐습니다');
      }
    } catch (err: any) {
      setPushPermission(getNotificationPermission());
      toastError(err?.message || '브라우저 알림 설정에 실패했습니다');
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    setPushBusy(true);
    try {
      const result = await sendTestPush();
      toastQuiet(`테스트 알림 전송: ${result.sent}개`);
    } catch (err: any) {
      toastError(err?.message || '테스트 알림 전송 실패');
    } finally {
      setPushBusy(false);
    }
  };

  const isGroupOn = (group: GroupConfig) => {
    if (!prefs) return false;
    return prefs.events
      .filter((event) => group.events.includes(event.eventType))
      .some((event) => event.inApp || event.toast || event.webPush);
  };

  const updateGroup = (group: GroupConfig, enabled: boolean) => {
    if (!prefs) return;
    const patch = enabled ? group.on : group.off;
    void save({
      ...prefs,
      events: prefs.events.map((event) => (
        group.events.includes(event.eventType)
          ? { ...event, ...patch }
          : event
      )),
    });
  };

  if (loading) {
    return (
      <section className="space-y-4">
        <div className="h-5 w-28 rounded bg-surface-800 animate-pulse" />
        <div className="h-24 rounded-xl bg-surface-800/60 animate-pulse" />
        <div className="h-40 rounded-xl bg-surface-800/60 animate-pulse" />
      </section>
    );
  }

  if (!prefs) {
    return <div className="text-[14px] text-red-400">{error || '알림 설정을 사용할 수 없습니다.'}</div>;
  }

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[19px] font-semibold text-gray-100 tracking-tight">알림</h3>
          <p className="mt-1 text-[14px] leading-relaxed text-surface-500">
            세부 이벤트 대신 네 가지 묶음만 고릅니다. 프로젝트별 알림은 세션/프로젝트 메뉴에서 조정합니다.
          </p>
        </div>
        <div className="shrink-0 text-[12px] text-surface-500">
          {saving ? '저장 중' : savedAt ? '저장됨' : '자동 저장'}
        </div>
      </div>

      {error && <div className="text-[13px] text-red-300 p-3 border border-red-500/20 rounded-xl bg-red-500/8">{error}</div>}

      <div className="space-y-2">
        <h4 className="text-[14px] font-semibold text-gray-300">어디로 받을까요</h4>
        <div className="divide-y divide-surface-800 border-y border-surface-800">
          {globalChannels.map((item) => {
            const isPush = item.key === 'webPushEnabled';
            const disabled = isPush && (!isPushSupported() || pushConfigured === false || pushPermission === 'denied' || pushBusy);
            return (
              <div key={item.key} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-gray-200">{item.label}</div>
                  <div className="mt-0.5 text-[12px] text-surface-500">
                    {isPush && pushPermission === 'denied'
                      ? '브라우저 설정에서 알림 권한을 다시 허용해야 합니다'
                      : isPush && pushConfigured === false
                        ? '서버 Web Push 키 설정이 필요합니다'
                        : item.desc}
                  </div>
                </div>
                <Toggle
                  checked={!!prefs.global[item.key]}
                  disabled={disabled}
                  onChange={(next) => isPush ? void handlePushToggle(next) : updateGlobal(item.key, next)}
                />
              </div>
            );
          })}
        </div>
        {prefs.global.webPushEnabled && pushPermission === 'granted' && (
          <button
            type="button"
            disabled={pushBusy}
            onClick={handleTestPush}
            className="mt-2 text-[13px] text-surface-400 hover:text-gray-200 disabled:opacity-50"
          >
            테스트 알림 보내기
          </button>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-[14px] font-semibold text-gray-300">무엇을 받을까요</h4>
        <div className="divide-y divide-surface-800 border-y border-surface-800">
          {groups.map((group) => (
            <div key={group.id} className="py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-gray-200">{group.title}</div>
                <div className="mt-0.5 text-[12px] text-surface-500 leading-snug">{group.desc}</div>
              </div>
              <Toggle checked={isGroupOn(group)} onChange={(next) => updateGroup(group, next)} />
            </div>
          ))}
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-surface-500">
        프로젝트별 알림은 사이드바 우클릭 메뉴에서 조정하도록 분리할 예정입니다.
      </p>
    </section>
  );
}
