import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = [
  fs.readFileSync(path.resolve(__dirname, 'features/file-operation-feedback/save-operation.ts'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'components/layout/ViewerPane.tsx'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'hooks/useSessionLifecycle.ts'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'hooks/useSessionStartup.ts'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'hooks/useAppCollections.ts'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'hooks/usePersonalViewerActions.ts'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'components/layout/SessionLinkNotice.tsx'), 'utf8'),
].join('\n');

describe('App locale contract', () => {
  it('routes global session, personal file, favorite, and viewer feedback through layout keys', () => {
    for (const key of [
      'layout:newSessionCreateFailed',
      'requestedSessionNotFoundTitle',
      "i18n.t('fileOperation.saved', { ns: 'common' })",
      "t('addedToFavorites', { name })",
      'layout:namedHome',
      "t('reopenViewer')",
      'layout:preparingNewSession',
    ]) {
      expect(source).toContain(key);
    }
  });
});
