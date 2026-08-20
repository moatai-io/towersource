import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileExchangeSurface } from '../../features/file-exchange/FileExchangeSurface';

function openPersonalPath(path: string) {
  window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path, split: 'right' } }));
}

/** User-owned files, notes, and Todo rendered as a dedicated Viewer Pane tab. */
export function PersonalMaterialsView() {
  const { t } = useTranslation('layout');

  return (
    <div className="flex h-full flex-col bg-surface-950 text-surface-100">
      <header className="shrink-0 border-b border-surface-800 px-4 py-4">
        <div>
          <h2 className="text-[18px] font-semibold">{t('myMaterials')}</h2>
          <p className="mt-1 text-[12px] leading-5 text-surface-500">{t('personalMaterialsDescription')}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <FileExchangeSurface personalOnly unifiedPersonal onOpenPersonalItem={openPersonalPath} />
        <div className="flex justify-end px-1 py-4">
          <button type="button" onClick={() => openPersonalPath('personal://archive')} className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-surface-500 hover:bg-surface-900 hover:text-surface-200" aria-label={t('personalArchive.open')}>··· {t('personalArchive.title')}</button>
        </div>
      </div>
    </div>
  );
}
