import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const header = fs.readFileSync(new URL('./Header.tsx', import.meta.url), 'utf8');

describe('Hamburger archive entry', () => {
  it('opens the full archived session directory instead of the legacy popover', () => {
    expect(header).toContain('testId="global-nav-archive"');
    expect(header).toContain("new CustomEvent('tower-open-session-directory', { detail: { mode: 'archived' } })");
    expect(header).not.toContain("import { SessionTrash }");
    expect(header).not.toContain('<SessionTrash');
    expect(header).not.toContain('trashOpen');
  });
});
