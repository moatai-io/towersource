import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');

describe('ContextPanel personal file guards', () => {
  it('reloads compare content through the Personal Space endpoint', () => {
    expect(source).toContain("openFile.path.startsWith('personal://')");
    expect(source).toContain('/api/personal-space/files/read?uri=');
  });

  it('does not expose workspace sharing for personal files', () => {
    expect(source).toContain('showShareModal && !isPersonalFile');
    expect(source).toContain('{!isPersonalFile && (');
  });
});
