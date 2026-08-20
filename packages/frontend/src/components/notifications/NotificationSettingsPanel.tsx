import React from 'react';
import { useTranslation } from 'react-i18next';
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
  titleKey: string;
  descKey: string;
  events: string[];
  on: Pick<EventPreference, 'inApp' | 'toast' | 'webPush'>;
  off: Pick<EventPreference, 'inApp' | 'toast' | 'webPush'>;
};

const groups: GroupConfig[] = [
  {
    id: 'direct',
    titleKey: 'groupDirectTitle',
    descKey: 'groupDirectDescription',
    events: ['message.mention'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'longTaskDone',
    titleKey: 'groupLongTaskDoneTitle',
    descKey: 'groupLongTaskDoneDescription',
    events: ['task.completed'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'needsAction',
    titleKey: 'groupNeedsActionTitle',
    descKey: 'groupNeedsActionDescription',
    events: ['task.failed', 'automation.failed'],
    on: { inApp: true, toast: true, webPush: true },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'aiDone',
    titleKey: 'groupAiDoneTitle',
    descKey: 'groupAiDoneDescription',
    events: ['session.completed', 'spawn.completed', 'proactive.message'],
    on: { inApp: true, toast: true, webPush: false },
    off: { inApp: false, toast: false, webPush: false },
  },
  {
    id: 'updates',
    titleKey: 'groupUpdatesTitle',
    descKey: 'groupUpdatesDescription',
    events: ['automation.completed', 'message.room', 'system.announcement'],
    on: { inApp: true, toast: false, webPush: false },
    off: { inApp: false, toast: false, webPush: false },
  },
];

const globalChannels = [
  { key: 'inAppEnabled', labelKey: 'channelInAppLabel', descKey: 'channelInAppDescription' },
  { key: 'toastEnabled', labelKey: 'channelToastLabel', descKey: 'channelToastDescription' },
  { key: 'webPushEnabled', labelKey: 'channelWebPushLabel', descKey: 'channelWebPushDescription' },
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
  const { t } = useTranslation('settings');
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
      .catch((err) => { if (!cancelled) setError(err.message || t('loadFailed')); })
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
      setError(err?.message || t('saveFailed'));
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
        toastSuccess(t('browserNotificationsEnabled'));
      } else {
        // Turning off should never be blocked by browser/SW cleanup. Persist the
        // Tower preference first, then best-effort unsubscribe this browser.
        await save({ ...prefs, global: { ...prefs.global, webPushEnabled: false } });
        await unsubscribeFromWebPush().catch(() => {});
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
    setPushBusy(true);
    try {
      const result = await sendTestPush();
      toastQuiet(t('testNotificationSent', { count: result.sent }));
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

      {error && <div className="text-[13px] text-red-300 p-3 border border-red-500/20 rounded-xl bg-red-500/8">{error}</div>}

      <div className="space-y-2">
        <h4 className="text-[14px] font-semibold text-gray-300">{t('deliveryTitle')}</h4>
        <div className="divide-y divide-surface-800 border-y border-surface-800">
          {globalChannels.map((item) => {
            const isPush = item.key === 'webPushEnabled';
            const disabled = isPush && (!isPushSupported() || pushConfigured === false || pushPermission === 'denied' || pushBusy);
            return (
              <div key={item.key} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-gray-200">{t(item.labelKey)}</div>
                  <div className="mt-0.5 text-[12px] text-surface-500">
                    {isPush && pushPermission === 'denied'
                      ? t('browserPermissionRequired')
                      : isPush && pushConfigured === false
                        ? t('webPushConfigurationRequired')
                        : t(item.descKey)}
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
              <Toggle checked={isGroupOn(group)} onChange={(next) => updateGroup(group, next)} />
            </div>
          ))}
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-surface-500">
        {t('projectNotificationHint')}
      </p>
    </section>
  );
}
