import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpaceStore } from '../../stores/space-store';
import type { Project } from '@tower/shared';

interface SpaceFilterProps {
  projects: Project[];
}

export function SpaceFilter({ projects }: SpaceFilterProps) {
  const { t } = useTranslation('layout');
  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId);
  const setActiveSpace = useSpaceStore((s) => s.setActiveSpace);

  // Count projects per space
  const counts = useMemo(() => {
    const map = new Map<number | null, number>();
    map.set(null, projects.length); // "전체"
    for (const p of projects) {
      const sid = p.spaceId ?? -1; // -1 = 미분류
      map.set(sid, (map.get(sid) || 0) + 1);
    }
    return map;
  }, [projects]);

  if (spaces.length === 0) return null;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 overflow-x-auto scrollbar-none border-b border-surface-800/50">
      {/* 전체 탭 */}
      <button
        onClick={() => setActiveSpace(null)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[13px] font-medium whitespace-nowrap transition-all ${
          activeSpaceId === null
            ? 'bg-surface-700 text-gray-200 shadow-sm'
            : 'text-surface-500 hover:text-gray-400 hover:bg-surface-800/50'
        }`}
      >
        <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />
        {t('all')}
        <span className="text-[12px] tabular-nums opacity-60">{counts.get(null) || 0}</span>
      </button>

      {/* Space 탭들 */}
      {spaces.map((space) => {
        const count = counts.get(space.id) || 0;
        const isActive = activeSpaceId === space.id;
        return (
          <button
            key={space.id}
            onClick={() => setActiveSpace(space.id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[13px] font-medium whitespace-nowrap transition-all ${
              isActive
                ? 'bg-surface-700 text-gray-200 shadow-sm'
                : 'text-surface-500 hover:text-gray-400 hover:bg-surface-800/50'
            }`}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: space.color }}
            />
            {space.name}
            <span className="text-[12px] tabular-nums opacity-60">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
