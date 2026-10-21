import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = [
  fs.readFileSync(path.resolve(__dirname, 'features/session-prefetch/prefetchSessionMessages.ts'), 'utf8'),
  fs.readFileSync(path.resolve(__dirname, 'hooks/useSessionSelection.ts'), 'utf8'),
].join('\n');

describe('App session message loading', () => {
  it('preserves message short ids across prefetch, cache refresh, and initial full loads', () => {
    expect(source).toContain('shortId: message.short_id || undefined');
    const selectionMappings = source.match(/shortId: m\.short_id \|\| undefined/g) ?? [];
    expect(selectionMappings).toHaveLength(2);
  });
});
