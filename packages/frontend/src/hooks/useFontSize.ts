import { useEffect } from 'react';
import { useSettingsStore, type FontSize } from '../stores/settings-store';

export function useFontSize() {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  // Apply data-font-size attribute to <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-font-size', fontSize);
  }, [fontSize]);

  return { fontSize, setFontSize };
}
