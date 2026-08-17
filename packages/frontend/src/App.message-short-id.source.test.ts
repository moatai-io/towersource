import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');

describe('App session message loading', () => {
  it('preserves message short ids across prefetch, cache refresh, and initial full loads', () => {
    const mappings = source.match(/shortId: m\.short_id \|\| undefined/g) ?? [];
    expect(mappings).toHaveLength(3);
  });
});
