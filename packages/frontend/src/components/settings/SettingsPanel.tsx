import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, type LangId, type FontSize } from '../../stores/settings-store';
import { useSessionStore } from '../../stores/session-store';
import { MyProfileModal, ChangePasswordModal } from '../auth/UserSelfModals';
import { NotificationSettingsPanel } from '../notifications/NotificationSettingsPanel';

export function SettingsPanel() {
  const { t, i18n } = useTranslation('settings');
  const isOpen = useSettingsStore((s) => s.isOpen);
  const setOpen = useSettingsStore((s) => s.setOpen);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const serverConfig = useSettingsStore((s) => s.serverConfig);
  const isMobile = useSessionStore((s) => s.isMobile);
  const activeView = useSessionStore((s) => s.activeView);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [passwordOpen, setPasswordOpen] = React.useState(false);

  const handleLanguageChange = (lang: LangId) => {
    setLanguage(lang);
    i18n.changeLanguage(lang);
    fetch('/api/me/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang }),
    }).catch(() => {});
  };

  if (!isOpen) return null;

  return (
    <div data-testid="settings-panel" className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Modal */}
      <div className="relative bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl w-[calc(100vw-32px)] max-w-[920px] max-h-[84vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-800">
          <h2 className="text-[17px] font-bold text-surface-100">{t('mySettings')}</h2>
          <button
            onClick={() => setOpen(false)}
            aria-label={t('common:close')}
            title={t('common:close')}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] max-h-[calc(84vh-58px)] overflow-auto">
          <div className="p-5 lg:p-6 space-y-5 border-b lg:border-b-0 lg:border-r border-surface-800 bg-surface-950/25">
          {/* Account */}
          <section>
            <h3 className="text-[14px] font-semibold text-surface-500 uppercase tracking-wider mb-3">{t('account')}</h3>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setProfileOpen(true)}
                className="py-2 px-2 text-sm font-medium rounded-lg border bg-surface-900 border-surface-700 text-surface-400 hover:border-surface-600 hover:text-gray-300 transition-all"
              >
                {t('myProfile')}
              </button>
              <button
                onClick={() => setPasswordOpen(true)}
                className="py-2 px-2 text-sm font-medium rounded-lg border bg-surface-900 border-surface-700 text-surface-400 hover:border-surface-600 hover:text-gray-300 transition-all"
              >
                {t('changePassword')}
              </button>
            </div>
          </section>

          {/* Language selector */}
          <section>
            <h3 className="text-[14px] font-semibold text-surface-500 uppercase tracking-wider mb-3">{t('language')}</h3>
            <select
              value={language}
              onChange={(event) => handleLanguageChange(event.target.value as LangId)}
              aria-label={t('language')}
              className="w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm font-medium text-surface-200 outline-none transition-colors focus:border-primary-500"
            >
              <option value="en">{t('english')}</option>
              <option value="ko">{t('korean')}</option>
            </select>
          </section>

          {/* Font size selector */}
          <section>
            <h3 className="text-[14px] font-semibold text-surface-500 uppercase tracking-wider mb-3">{t('fontSize')}</h3>
            <div className="flex gap-2">
              {([
                { id: 'small' as FontSize, label: t('fontSmall'), preview: 'A' },
                { id: 'medium' as FontSize, label: t('fontMedium'), preview: 'A' },
                { id: 'large' as FontSize, label: t('fontLarge'), preview: 'A' },
              ]).map(({ id, label, preview }) => (
                <button
                  key={id}
                  onClick={() => setFontSize(id)}
                  className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-all flex flex-col items-center gap-1 ${
                    fontSize === id
                      ? 'bg-surface-800 border-primary-500 text-primary-400'
                      : 'bg-surface-900 border-surface-700 text-surface-500 hover:border-surface-600'
                  }`}
                >
                  <span style={{ fontSize: id === 'small' ? '15px' : id === 'medium' ? '17px' : '20px' }}>{preview}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* View mode — mobile only (desktop has header toggle) */}
          {isMobile && (
            <section>
              <h3 className="text-[14px] font-semibold text-surface-500 uppercase tracking-wider mb-3">{t('view')}</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveView('chat')}
                  className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-all ${
                    activeView === 'chat'
                      ? 'bg-surface-800 border-primary-500 text-primary-400'
                      : 'bg-surface-900 border-surface-700 text-surface-500 hover:border-surface-600'
                  }`}
                >
                  AI
                </button>
                <button
                  onClick={() => setActiveView('kanban')}
                  className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-all ${
                    activeView === 'kanban'
                      ? 'bg-surface-800 border-primary-500 text-primary-400'
                      : 'bg-surface-900 border-surface-700 text-surface-500 hover:border-surface-600'
                  }`}
                >
                  Task
                </button>
              </div>
            </section>
          )}

          {/* About — version info */}
          <section className="pt-3 border-t border-surface-800">
            <div className="flex items-center justify-between text-[13px] text-surface-500">
              <span>Tower</span>
              <span className="font-mono">
                v{serverConfig?.version ?? '—'}
                {(serverConfig as { gitSha?: string } | null)?.gitSha
                  ? ` · ${(serverConfig as { gitSha?: string }).gitSha!.slice(0, 7)}`
                  : ''}
              </span>
            </div>
          </section>
          </div>

          <div className="p-5 lg:p-6 bg-surface-900">
            <NotificationSettingsPanel />
          </div>
        </div>
      </div>

      {profileOpen && (
        <MyProfileModal
          token={localStorage.getItem('token')}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {passwordOpen && (
        <ChangePasswordModal
          token={localStorage.getItem('token')}
          onClose={() => setPasswordOpen(false)}
          onPasswordChanged={(newToken) => {
            localStorage.setItem('token', newToken);
          }}
        />
      )}
    </div>
  );
}
