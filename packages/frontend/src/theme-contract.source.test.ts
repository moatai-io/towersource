import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('packages/frontend/src');
const settingsStore = fs.readFileSync(path.join(root, 'stores/settings-store.ts'), 'utf-8');
const useTheme = fs.readFileSync(path.join(root, 'hooks/useTheme.ts'), 'utf-8');
const settingsPanel = fs.readFileSync(path.join(root, 'components/settings/SettingsPanel.tsx'), 'utf-8');
const styles = fs.readFileSync(path.join(root, 'index.css'), 'utf-8');

describe('Tower two-theme contract', () => {
  it('only exposes light and dark theme ids and normalizes legacy saved values', () => {
    expect(settingsStore).toContain("export type ThemeId = 'dark' | 'light'");
    expect(settingsStore).toContain("if (saved === 'light' || saved === 'dark') return saved");
    expect(settingsStore).toContain("localStorage.setItem('theme', 'dark')");
    expect(settingsStore).toContain("matchMedia('(prefers-color-scheme: light)')");
  });

  it('keeps data-theme and Tailwind dark class synchronized', () => {
    expect(useTheme).toContain("setAttribute('data-theme', theme)");
    expect(useTheme).toContain("classList.toggle('dark', theme === 'dark')");
    expect(useTheme).toContain('style.colorScheme = theme');
  });

  it('binds dark utilities to the explicit Tower theme, never OS preference', () => {
    expect(styles).toContain('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));');
  });

  it('keeps the Team Home create action on semantic contrast tokens', () => {
    const sidebar = fs.readFileSync(path.join(root, 'components/layout/Sidebar.tsx'), 'utf-8');
    expect(sidebar).toContain('tone-accent tone-action border px-2 text-left');
    expect(sidebar).not.toContain('text-primary-700 hover:bg-primary-500/15 dark:text-primary-200');
  });

  it('removes personal palette selection and legacy theme selectors', () => {
    expect(settingsPanel).not.toContain('themeOptions');
    expect(settingsPanel).not.toContain('setTheme(');
    for (const legacy of ['ocean', 'forest', 'aurora']) {
      expect(styles).not.toContain(`data-theme="${legacy}"`);
    }
  });
});
