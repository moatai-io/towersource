import { towerHttpUrl, readBrowserAuthToken } from '../../features/client-connection/connection';
import { isAnswerSoundEnabled, setAnswerSoundEnabled, playAnswerSound, ANSWER_SOUND_STYLES, getAnswerSoundStyle, setAnswerSoundStyle, type AnswerSoundStyle } from '../../features/answer-sound/answer-sound';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { toastError, toastQuiet, toastSuccess } from '../../utils/toast';
import {
  getNotificationPermission,
  getVapidInfo,
  isPushSupported,
  hasLocalPushSubscription,
  sendTestPush,
  subscribeToWebPush,
  unsubscribeFromWebPush,
} from '../../lib/push-notifications';


function getToken() {
  return readBrowserAuthToken() || '';
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

type GroupConfig = {
  id: string;
  titleKey: string;
  descKey: string;
  events: string[];
  on: Pick<EventPreference, 'inApp' | 'toast' | 'webPush'>;
  off: Pick<EventPreference, 'inApp' | 'toast' | 'webPush'>;
};

// Expose only current session and scheduled-work controls. Legacy event
// preferences remain untouched in the payload for compatibility.
const groups: GroupConfig[] = [
  {
    id: 'answers', titleKey: 'groupAnswersTitle', descKey: 'groupAnswersDescription',
    events: ['session.completed', 'spawn.completed', 'proactive.message', 'task.completed', 'task.failed'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'scheduled', titleKey: 'groupScheduledTitle', descKey: 'groupScheduledDescription',
    events: ['automation.completed', 'automation.failed'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
];

const globalChannels = [
  { key: 'inAppEnabled', labelKey: 'channelInAppLabel', descKey: 'channelInAppDescription' },
  { key: 'toastEnabled', labelKey: 'channelToastLabel', descKey: 'channelToastDescription' },
  { key: 'webPushEnabled', labelKey: 'channelWebPushLabel', descKey: 'channelWebPushDescription' },
] as const;

function Toggle({ checked, onChange, disabled = false, label }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-8 w-14 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/60 ${
        checked ? 'tone-success tone-bg' : 'bg-surface-700'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:brightness-110'}`}
      role="switch"
      aria-label={label}
      aria-checked={checked}
    >
      <span
        className={`absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-transform duration-150 ${
          checked ? 'translate-x-6' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function NotificationSettingsPanel() {
  const { t } = useTranslation('settings');
  const [soundStyle, setSoundStyle] = React.useState(getAnswerSoundStyle);
  const [soundEnabled, setSoundEnabled] = React.useState(isAnswerSoundEnabled);
  const [prefs, setPrefs] = React.useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [pushConfigured, setPushConfigured] = React.useState<boolean | null>(null);
  const [pushPermission, setPushPermission] = React.useState<NotificationPermission | 'unsupported'>(
    typeof window === 'undefined' ? 'unsupported' : getNotificationPermission(),
  );
  const saveLock = React.useRef(false);
  const [deviceSubscribed, setDeviceSubscribed] = React.useState(false);
  const [pushLookupFailed, setPushLookupFailed] = React.useState(false);
  const [pushBusy, setPushBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(towerHttpUrl(`/api/notification-preferences`), {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => { if (!cancelled) setPrefs(data); })
      .catch((err) => { if (!cancelled) setError(err.message || t('loadFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });

    if (isPushSupported()) {
      hasLocalPushSubscription().then(value => { if (!cancelled) setDeviceSubscribed(value); }).catch(() => {});
      getVapidInfo()
        .then((info) => { if (!cancelled) setPushConfigured(info.configured); })
        .catch(() => { if (!cancelled) setPushLookupFailed(true); });
    } else {
      setPushConfigured(false);
    }
    return () => { cancelled = true; };
  }, []);

  const save = React.useCallback(async (next: NotificationPreferences) => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(towerHttpUrl(`/api/notification-preferences`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPrefs(data);
      setSavedAt(Date.now());
      return true;
    } catch (err: any) {
      setError(err?.message || t('saveFailed'));
      return false;
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }, []);

  const updateGlobal = (key: keyof NotificationPreferences['global'], value: boolean) => {
    if (!prefs || saveLock.current || pushBusy) return;
    void save({ ...prefs, global: { ...prefs.global, [key]: value } });
  };

  const handlePushToggle = async (next: boolean) => {
    if (!prefs || saveLock.current || pushBusy) return;
    setPushBusy(true);
    try {
      if (next) {
        setError(null);
        await subscribeToWebPush();
        setPushPermission(getNotificationPermission());
        setDeviceSubscribed(true);
        if (!await save({ ...prefs, global: { ...prefs.global, webPushEnabled: true } })) return;
        toastSuccess(t('browserNotificationsEnabled'));
      } else {
        // Turning off should never be blocked by browser/SW cleanup. Persist the
        // Tower preference first, then best-effort unsubscribe this browser.
        if (!await save({ ...prefs, global: { ...prefs.global, webPushEnabled: false } })) return;
        await unsubscribeFromWebPush().catch(() => {});
        setDeviceSubscribed(false);
        setPushPermission(getNotificationPermission());
        toastQuiet(t('browserNotificationsDisabled'));
      }
    } catch (err: any) {
      setPushPermission(getNotificationPermission());
      toastError(err?.message || t('browserNotificationSettingsFailed'));
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    if (pushBusy || saveLock.current) return;
    setPushBusy(true);
    try {
      const result = await sendTestPush();
      if (result.sent === 0 || result.failed > 0) {
        toastError(t('testNotificationIncomplete', { sent: result.sent, failed: result.failed }));
      } else toastQuiet(t('testNotificationSent', { count: result.sent }));
    } catch (err: any) {
      toastError(err?.message || t('testNotificationFailed'));
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
    if (!prefs || saveLock.current || pushBusy) return;
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
    return <div className="text-[14px] text-red-400">{error || t('unavailable')}</div>;
  }

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[19px] font-semibold text-gray-100 tracking-tight">{t('notifications')}</h3>
          <p className="mt-1 text-[14px] leading-relaxed text-surface-500">{t('notificationDescription')}</p>
        </div>
        <div className="shrink-0 text-[12px] text-surface-500">
          {saving ? t('saving') : savedAt ? t('saved') : t('autoSave')}
        </div>
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-surface-700 p-4">
        <input type="checkbox" className="mt-1" checked={soundEnabled} onChange={(event) => {
          const enabled = event.target.checked;
          void setAnswerSoundEnabled(enabled).then((played) => {
            if (enabled && !played) setError(t('answerSoundFailed'));
          });
          setSoundEnabled(isAnswerSoundEnabled());
        }} />
        <span>
          <span className="block text-sm font-medium">{t('answerSoundTitle')}</span>
          <span className="mt-1 block text-sm text-surface-500">{t('answerSoundDescription')}</span>
        </span>
      </label>

      <label className="block text-sm">
        <span className="mr-3">{t('answerSoundStyle')}</span>
        <select className="rounded border border-surface-600 bg-surface-900 p-2" value={soundStyle} onChange={(event) => {
          const style = event.target.value as AnswerSoundStyle;
          setAnswerSoundStyle(style);
          setSoundStyle(getAnswerSoundStyle());
          setError(null);
          void playAnswerSound(style).then((played) => {
            if (!played) setError(t('answerSoundFailed'));
          });
        }}>
          {ANSWER_SOUND_STYLES.map((style) => <option key={style} value={style}>{t(`answerSoundStyles.${style}`)}</option>)}
        </select>
      </label>

      <button type="button" className="text-sm underline text-surface-400" onClick={() => {
        setError(null);
        void playAnswerSound().then((played) => {
          if (!played) setError(t('answerSoundFailed'));
        });
      }}>{t('answerSoundPreview')}</button>

      {error && <div className="text-[13px] text-red-300 p-3 border border-red-500/20 rounded-xl bg-red-500/8">{error}</div>}

      <div className="space-y-2">
        <h4 className="text-[14px] font-semibold text-gray-300">{t('deliveryTitle')}</h4>
        <div className="divide-y divide-surface-800 border-y border-surface-800">
          {globalChannels.map((item) => {
            const isPush = item.key === 'webPushEnabled';
            const disabled = saving || pushBusy || (isPush && !prefs.global.webPushEnabled && (!isPushSupported() || pushConfigured !== true || pushPermission === 'denied'));
            return (
              <div key={item.key} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-gray-200">{t(item.labelKey)}</div>
                  <div className="mt-0.5 text-[12px] text-surface-500">
                    {isPush && !isPushSupported()
                      ? t(/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'iosPushHint' : 'pushUnsupported')
                      : isPush && pushLookupFailed
                      ? t('pushLookupFailed')
                      : isPush && pushPermission === 'denied'
                      ? t('browserPermissionRequired')
                      : isPush && pushConfigured === false
                        ? t('webPushConfigurationRequired')
                        : isPush && /iPhone|iPad|iPod/i.test(navigator.userAgent)
                          ? t('iosPushHint')
                          : t(item.descKey)}
                  </div>
                </div>
                <Toggle
                  label={t(item.labelKey)}
                  checked={!!prefs.global[item.key]}
                  disabled={disabled}
                  onChange={(next) => isPush ? void handlePushToggle(next) : updateGlobal(item.key, next)}
                />
              </div>
            );
          })}
        </div>
        {prefs.global.webPushEnabled && (
          <div className="mt-2 text-sm" role="status">
            {t(deviceSubscribed && pushPermission === 'granted' ? 'pushDeviceRegistered' : 'pushDeviceNeeded')}
            {(!deviceSubscribed || pushPermission !== 'granted') && isPushSupported() && pushPermission !== 'denied' && (
              <button type="button" disabled={saving || pushBusy || pushConfigured !== true} className="ml-2 underline" onClick={() => void handlePushToggle(true)}>{t('pushConnectDevice')}</button>
            )}
          </div>
        )}
        {prefs.global.webPushEnabled && deviceSubscribed && pushPermission === 'granted' && (
          <button
            type="button"
            disabled={pushBusy || saving}
            onClick={handleTestPush}
            className="mt-2 text-[13px] text-surface-400 hover:text-gray-200 disabled:opacity-50"
          >
            {t('sendTestNotification')}
          </button>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-[14px] font-semibold text-gray-300">{t('eventTypesTitle')}</h4>
        <div className="divide-y divide-surface-800 border-y border-surface-800">
          {groups.map((group) => (
            <div key={group.id} className="py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-gray-200">{t(group.titleKey)}</div>
                <div className="mt-0.5 text-[12px] text-surface-500 leading-snug">{t(group.descKey)}</div>
              </div>
              <Toggle label={t(group.titleKey)} disabled={saving || pushBusy} checked={isGroupOn(group)} onChange={(next) => updateGroup(group, next)} />
            </div>
          ))}
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-surface-500">
        {t('notificationDeliveryHint')}
      </p>
    </section>
  );
}
