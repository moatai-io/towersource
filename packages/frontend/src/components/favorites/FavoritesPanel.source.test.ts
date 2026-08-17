import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync(path.resolve(import.meta.dirname, './FavoritesPanel.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Header.tsx'), 'utf8');

describe('Favorites hub', () => {
  it('shows only durable file and folder pins with dates and owning agents', () => {
    expect(panel).toContain(".pin_type !== 'prompt'");
    expect(panel).toContain('pin.created_at');
    expect(panel).toContain('pin.file_path');
    expect(panel).toContain('담당 에이전트');
    expect(panel).toContain("project?.agent?.displayName");
    expect(panel).not.toContain("session.favorite");
    expect(panel).not.toContain("project.pinned");
  });

  it('opens from the hamburger menu in the main pane', () => {
    expect(header).toContain("label={t('favorites')}");
    expect(app).toContain("useSessionStore.getState().setActiveView('favorites')");
    expect(app).toContain("activeView === 'favorites'");
    expect(app).toContain('<FavoritesPanel');
  });

  it('offers favorite and path-copy actions from the Viewer tab context menu', () => {
    expect(app).toContain("? t('layout:removeFromFavorites') : t('layout:addToFavorites')");
    expect(app).toContain('void handlePinFile(tab.path)');
    expect(app).toContain('void handleUnpinFile(favorite.id)');
    expect(app).toContain('await navigator.clipboard.writeText(tab.path)');
    expect(app).toContain("toastQuiet(t('layout:pathCopied'))");
    expect(app).toContain("{t('layout:copyPath')}");
  });
});
