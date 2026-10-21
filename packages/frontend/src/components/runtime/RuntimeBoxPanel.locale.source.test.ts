import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'RuntimeBoxPanel.tsx'), 'utf8');

describe('RuntimeBoxPanel locale contract', () => {
  it('routes capacity, stop, cleanup, and empty states through locale keys', () => {
    for (const key of [
      'runtimeBox.recoveredError',
      'runtimeBox.legacyScope',
      'runtimeBox.boxCount',
      'runtimeBox.capacity.exceedsTitle',
      'runtimeBox.capacity.serverLimit',
      'runtimeBox.stop.message',
      'runtimeBox.cleanup.message',
      'runtimeBox.noServices',
    ]) expect(source).toContain(key);
  });
});
