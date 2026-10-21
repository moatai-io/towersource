import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync(path.resolve(import.meta.dirname, './FavoritesPanel.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const viewer = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/ViewerPane.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Header.tsx'), 'utf8');

describe('Favorites hub', () => {
  it('shows only durable file and folder pins with dates and owning agents', () => {
    expect(panel).toContain(".pin_type !== 'prompt'");
    expect(panel).toContain('pin.created_at');
    expect(panel).toContain('pin.file_path');
    expect(panel).toContain("t('favoritesView.agent')");
    expect(panel).toContain("project?.agent?.displayName");
    expect(panel).toContain("i18n.resolvedLanguage || i18n.language");
    expect(panel).not.toContain("session.favorite");
    expect(panel).not.toContain("project.pinned");
  });

  it('keeps the durable favorites hub out of the hamburger menu', () => {
    expect(header).not.toContain("label={t('favorites')}");
    expect(header).not.toContain('testId="global-nav-favorites"');
    expect(app).not.toContain("onPinsClick={() =>");
  });

  it('offers favorite and path-copy actions from the Viewer tab context menu', () => {
    expect(viewer).toContain("favorite ? t('removeFromFavorites') : t('addToFavorites')");
    expect(viewer).toContain('tab ? onPinFile(tab.path)');
    expect(viewer).toContain('onUnpinFile(favorite.id)');
    expect(viewer).toContain('await navigator.clipboard.writeText(tab.path)');
    expect(viewer).toContain("toastQuiet(t('pathCopied'))");
    expect(viewer).toContain("{t('copyPath')}");
  });
});
