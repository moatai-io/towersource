import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const store = fs.readFileSync(path.resolve(import.meta.dirname, './personal-space-store.ts'), 'utf8');
const route = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/personal-space-api.ts'), 'utf8');
const surface = fs.readFileSync(path.resolve(import.meta.dirname, '../../../frontend/src/features/file-exchange/FileExchangeSurface.tsx'), 'utf8');

describe('Personal Space folder browser contract', () => {
  it('keeps folder operations inside the Personal Space module', () => {
    expect(store).toContain('listPersonalDirectory');
    expect(store).toContain('createPersonalDirectory');
    expect(store).toContain('movePersonalEntry');
    expect(store).toContain('Personal files cannot be symlinks');
  });

  it('exposes path-scoped folder APIs without host paths', () => {
    expect(route).toContain("router.get('/files/directory'");
    expect(route).toContain("router.post('/files/create-directory'");
    expect(route).toContain("router.post('/files/move'");
    expect(route).toContain("router.post('/files/archive'");
  });

  it('renders breadcrumbs, folder upload, search, sort, multi-select, move and archive', () => {
    for (const text of ['personalPath', 'breadcrumbs', "t('fileExchange.addFolder')", "t('fileExchange.searchPlaceholder')", "t('fileExchange.sortModified')", 'selectedIds', "t('fileExchange.changeNameLocation')", "t('fileExchange.archive')"]) {
      expect(surface).toContain(text);
    }
    expect(surface).toContain("form.append('directory', targetDirectory)");
    expect(surface).toContain("unifiedPersonal && !personalPath ? 'files' : personalPath || 'files'");
    expect(surface).toContain('/api/personal-space/files/directory');
  });
});
