import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settings-store';

export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  // Keep Tower's CSS-token selector and Tailwind's dark variant on the same two-state contract.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Listen for system preference changes (only when no saved preference)
  useEffect(() => {
    if (localStorage.getItem('theme')) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? 'light' : 'dark');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [setTheme]);

  // Initialize from system preference if no saved theme
  useEffect(() => {
    if (!localStorage.getItem('theme')) {
      const preferLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      setTheme(preferLight ? 'light' : 'dark');
    }
  }, [setTheme]);

  return { theme, setTheme, isDark: theme === 'dark' };
}
