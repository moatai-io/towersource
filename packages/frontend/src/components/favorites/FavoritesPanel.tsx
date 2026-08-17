import React from 'react';
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
  if (!value) return '날짜 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '날짜 없음';
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
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
  return project?.agent?.displayName || '공용 자료';
}

function kindLabel(kind: FavoriteItem['kind'], detail: string): string {
  if (kind === 'folder') return '폴더';
  if (/\.html?$/i.test(detail)) return 'HTML';
  return '파일';
}

/** Main-pane hub for the user's durable file and folder favorites. */
export function FavoritesPanel({ projects, onOpenPin, onRemovePin }: FavoritesPanelProps) {
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
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-primary-400">내 공간</p>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 id="favorites-title" className="text-2xl font-semibold text-surface-100">즐겨찾기</h1>
              <p className="mt-1 text-sm text-surface-400">예전에 저장해둔 HTML·대시보드·문서를 다시 엽니다.</p>
            </div>
            <div className="rounded-full border border-surface-700 bg-surface-900 px-3 py-1 text-[12px] font-medium text-surface-300">{items.length}개</div>
          </div>
        </header>

        {items.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-surface-700 bg-surface-900/35 px-6 py-14 text-center">
            <div className="text-3xl" aria-hidden="true">☆</div>
            <h2 className="mt-3 text-base font-semibold text-surface-200">아직 즐겨찾기가 없습니다</h2>
            <p className="mt-1 text-sm text-surface-500">Viewer나 파일 목록에서 파일을 즐겨찾기에 추가해보세요.</p>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-surface-800 bg-surface-900/55">
            <div className="hidden grid-cols-[minmax(0,1fr)_10rem_9rem_2.5rem] gap-4 border-b border-surface-800 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-surface-500 md:grid">
              <span>항목</span><span>담당 에이전트</span><span>날짜</span><span />
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
                <button type="button" onClick={item.onRemove} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg text-surface-500 hover:bg-surface-700 hover:text-red-300" aria-label={`${item.title} 즐겨찾기 해제`} title="즐겨찾기 해제">×</button>
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
