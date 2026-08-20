import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');

describe('App locale contract', () => {
  it('routes global session, personal file, favorite, and viewer feedback through layout keys', () => {
    for (const key of [
      'layout:newSessionCreateFailed',
      'layout:requestedSessionNotFound',
      'layout:personalNoteSaved',
      'layout:addedToFavorites',
      'layout:namedHome',
      'layout:reopenViewer',
      'layout:preparingNewSession',
    ]) {
      expect(source).toContain(key);
    }
  });
});
