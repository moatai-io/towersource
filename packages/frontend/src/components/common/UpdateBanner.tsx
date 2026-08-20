import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings-store';

interface UpdateBannerProps {
  onReload: () => void;
  onDeferReload?: () => void;
  onCancelDeferred?: () => void;
  busy?: boolean;
}

export function UpdateBanner({ onReload, onDeferReload, onCancelDeferred, busy = false }: UpdateBannerProps) {
  const { t } = useTranslation('common');
  const updateAvailable = useSettingsStore((s) => s.updateAvailable);
  const deferredUpdateRequested = useSettingsStore((s) => s.deferredUpdateRequested);
  if (!updateAvailable) return null;

  return (
    <div role="status" className="bg-primary-600/15 border-b border-primary-500/25 text-primary-50 px-4 py-2 shrink-0">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 text-[14px] flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-2 h-2 rounded-full bg-primary-300 shrink-0" />
          <span className="truncate">
            {deferredUpdateRequested
              ? t('updateBanner.deferred')
              : busy
                ? t('updateBanner.busy')
                : t('updateBanner.ready')}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {busy && !deferredUpdateRequested && onDeferReload && (
            <button
              onClick={onDeferReload}
              className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/15 border border-white/15 text-[13px] font-semibold transition-colors"
            >
              {t('updateBanner.updateAfterTurn')}
            </button>
          )}
          {deferredUpdateRequested && onCancelDeferred && (
            <button
              onClick={onCancelDeferred}
              className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/15 border border-white/15 text-[13px] font-semibold transition-colors"
            >
              {t('updateBanner.cancelDeferred')}
            </button>
          )}
          <button
            onClick={onReload}
            className="px-2.5 py-1 rounded-md bg-primary-500/20 hover:bg-primary-500/30 border border-primary-400/30 text-[13px] font-semibold transition-colors shrink-0"
          >
            {t('updateBanner.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}
