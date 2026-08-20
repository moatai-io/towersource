import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { Project } from '@tower/shared';
import { usePinStore, type Pin } from '../../stores/pin-store';

interface FavoritesPanelProps {
  projects: Project[];
  onOpenPin: (pin: Pin) => void;
  onRemovePin: (id: number) => void;
}

type FavoriteItem = {
  key: string;
  kind: 'file' | 'folder';
  title: string;
  detail: string;
  date: string;
  agent: string;
  onOpen: () => void;
  onRemove: () => void;
};

function formatFavoriteDate(value?: string | null): string {
  if (!value) return i18n.t('favoritesView.noDate', { ns: 'layout' });
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t('favoritesView.noDate', { ns: 'layout' });
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function projectForPath(projects: Project[], path: string): Project | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return projects
    .filter((project) => !!project.rootPath)
    .sort((a, b) => (b.rootPath?.length || 0) - (a.rootPath?.length || 0))
    .find((project) => {
      const root = project.rootPath!.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalized === root || normalized.startsWith(`${root}/`);
    });
}

function agentLabel(project?: Project): string {
  return project?.agent?.displayName || i18n.t('favoritesView.sharedMaterials', { ns: 'layout' });
}

function kindLabel(kind: FavoriteItem['kind'], detail: string): string {
  if (kind === 'folder') return i18n.t('favoritesView.folder', { ns: 'layout' });
  if (/\.html?$/i.test(detail)) return 'HTML';
  return i18n.t('favoritesView.file', { ns: 'layout' });
}

/** Main-pane hub for the user's durable file and folder favorites. */
export function FavoritesPanel({ projects, onOpenPin, onRemovePin }: FavoritesPanelProps) {
  const { t } = useTranslation('layout');
  const pins = usePinStore((state) => state.pins);

  const items = React.useMemo<FavoriteItem[]>(() => {
    return pins
      .filter((pin) => (pin as Pin & { pin_type?: string }).pin_type !== 'prompt')
      .map((pin) => {
        const project = projectForPath(projects, pin.file_path);
        return {
          key: `pin:${pin.id}`,
          kind: pin.file_type === 'folder' ? 'folder' as const : 'file' as const,
          title: pin.title,
          detail: pin.file_path,
          date: pin.created_at,
          agent: agentLabel(project),
          onOpen: () => onOpenPin(pin),
          onRemove: () => onRemovePin(pin.id),
        };
      })
      .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  }, [onOpenPin, onRemovePin, pins, projects]);

  return (
    <section data-testid="favorites-panel" className="h-full overflow-auto bg-surface-950 px-4 py-6 sm:px-7 sm:py-8" aria-labelledby="favorites-title">
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-surface-800 pb-5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-primary-400">{t('favoritesView.mySpace')}</p>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 id="favorites-title" className="text-2xl font-semibold text-surface-100">{t('favoritesView.title')}</h1>
              <p className="mt-1 text-sm text-surface-400">{t('favoritesView.description')}</p>
            </div>
            <div className="rounded-full border border-surface-700 bg-surface-900 px-3 py-1 text-[12px] font-medium text-surface-300">{t('favoritesView.count', { count: items.length })}</div>
          </div>
        </header>

        {items.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-surface-700 bg-surface-900/35 px-6 py-14 text-center">
            <div className="text-3xl" aria-hidden="true">☆</div>
            <h2 className="mt-3 text-base font-semibold text-surface-200">{t('favoritesView.emptyTitle')}</h2>
            <p className="mt-1 text-sm text-surface-500">{t('favoritesView.emptyDescription')}</p>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-surface-800 bg-surface-900/55">
            <div className="hidden grid-cols-[minmax(0,1fr)_10rem_9rem_2.5rem] gap-4 border-b border-surface-800 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-surface-500 md:grid">
              <span>{t('favoritesView.item')}</span><span>{t('favoritesView.agent')}</span><span>{t('favoritesView.date')}</span><span />
            </div>
            {items.map((item) => (
              <div key={item.key} className="group flex items-start gap-3 border-b border-surface-800/80 px-3 py-3 last:border-b-0 hover:bg-surface-800/60 md:grid md:grid-cols-[minmax(0,1fr)_10rem_9rem_2.5rem] md:items-center md:gap-4 md:px-4">
                <button type="button" onClick={item.onOpen} className="min-w-0 flex-1 text-left md:flex md:items-center md:gap-3">
                  <span className="inline-flex rounded-md border border-surface-700 bg-surface-900 px-2 py-0.5 text-[11px] font-medium text-surface-400">{kindLabel(item.kind, item.detail)}</span>
                  <span className="mt-1.5 block min-w-0 md:mt-0">
                    <span className="block truncate text-sm font-semibold text-surface-100 group-hover:text-primary-300">{item.title}</span>
                    <span className="mt-0.5 block truncate text-[12px] text-surface-500">{item.detail}</span>
                  </span>
                </button>
                <div className="hidden truncate text-[13px] text-surface-300 md:block">{item.agent}</div>
                <div className="hidden text-[12px] text-surface-500 md:block">{formatFavoriteDate(item.date)}</div>
                <button type="button" onClick={item.onRemove} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg text-surface-500 hover:bg-surface-700 hover:text-red-300" aria-label={t('favoritesView.removeLabel', { title: item.title })} title={t('favoritesView.remove')}>×</button>
                <div className="col-start-1 mt-2 flex gap-3 text-[11px] text-surface-500 md:hidden">
                  <span>{item.agent}</span><span>{formatFavoriteDate(item.date)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
