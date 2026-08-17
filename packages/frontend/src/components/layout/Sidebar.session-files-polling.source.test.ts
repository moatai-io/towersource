import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SessionFilesMenuSection.tsx', import.meta.url), 'utf8');

describe('Sidebar session files polling', () => {
  it('polls only while the panel and browser tab are visible', () => {
    expect(source).toContain("if (document.visibilityState === 'visible') void fetchFiles()");
    expect(source).toContain("document.addEventListener('visibilitychange', pollIfVisible)");
    expect(source).toContain("document.removeEventListener('visibilitychange', pollIfVisible)");
    expect(source).toContain('}, [activeSessionId]);');
  });

  it('still performs one immediate fetch when the active session changes', () => {
    expect(source).toMatch(/void fetchFiles\(\);[\s\S]*?const pollIfVisible/);
  });
});
