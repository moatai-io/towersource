import { useEffect } from 'react';
import { matchesShortcut, useShortcutStore } from '../stores/shortcut-store';

/** Use the same filtered order and selection callback as the visible sidebar. */
export function useSessionShortcuts<T extends { id: string }>(sessions: T[], activeId: string | null, select: (session: T) => void) {
  const bindings = useShortcutStore(s => s.bindings);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"], [data-shortcut-settings]')) return;
      const direction = matchesShortcut(event, bindings['session.previous']) ? -1
        : matchesShortcut(event, bindings['session.next']) ? 1 : 0;
      if (!direction || !sessions.length) return;
      const index = sessions.findIndex(session => session.id === activeId);
      const next = index < 0 ? (direction > 0 ? 0 : sessions.length - 1) : index + direction;
      if (next < 0 || next >= sessions.length) return;
      event.preventDefault();
      select(sessions[next]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bindings, sessions, activeId, select]);
}
