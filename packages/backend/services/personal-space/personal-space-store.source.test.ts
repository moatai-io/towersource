import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./personal-space-store.ts', import.meta.url), 'utf8');

describe('Personal Space inbox append source contract', () => {
  it('uses optimistic version retry and dated Markdown items', () => {
    expect(source).toContain('export async function appendToPersonalInbox');
    expect(source).toContain('current.version');
    expect(source).toContain("error.code !== 'CONFLICT'");
    expect(source).toContain("timeZone: 'Asia/Seoul'");
    expect(source).toContain("checklist ? '[ ] ' : ''");
    expect(source).toContain('lockfile.lock(storagePath');
    expect(source).not.toContain('source-session:');
  });

  it('keeps the append destination inside the private inbox', () => {
    expect(source).toContain("const DEFAULT_INBOX_PATH = 'notes/inbox.md'");
    expect(source).toContain('readPersonalFile(userId, DEFAULT_INBOX_PATH)');
  });
});
