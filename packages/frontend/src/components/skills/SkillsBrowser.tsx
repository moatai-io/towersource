import { useEffect } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { SkillsBrowserV2 } from './SkillsBrowserV2';

/**
 * SkillsBrowser — app entry wrapper for the current skill catalog.
 *
 * The legacy V1 implementation used to live in this file and could be revived
 * by `localStorage.skill-ui-version=v1` or `?skillUi=v1`. That made the UI
 * appear to roll back and hid the newer file navigation/details surface. The
 * wrapper now always renders V2 when the skills panel is open and clears stale
 * legacy toggles defensively.
 */
export function SkillsBrowser() {
  const open = useSettingsStore((s) => s.skillsBrowserOpen);

  useEffect(() => {
    localStorage.removeItem('skill-ui-version');
    if (window.location.search.includes('skillUi=v1')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('skillUi');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  if (!open) return null;
  return <SkillsBrowserV2 onSwitchToV1={() => {}} />;
}
