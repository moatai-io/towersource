import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { clonePiSessionFile } from './clone.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('clonePiSessionFile', () => {
  it('creates an independent native session while preserving compaction context', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-clone-'));
    roots.push(cwd);
    const sessionDir = path.join(cwd, '.pi', 'sessions');
    const source = SessionManager.create(cwd, sessionDir);
    source.appendMessage({ role: 'user', content: [{ type: 'text', text: 'old question' }], timestamp: 1 } as any);
    source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2, api: 'responses', provider: 'test', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' } as any);
    const keptId = source.appendMessage({ role: 'user', content: [{ type: 'text', text: 'keep this' }], timestamp: 3 } as any);
    source.appendCompaction('summary of older work', keptId, 1000);

    const sourceFile = source.getSessionFile()!;
    const clonedFile = clonePiSessionFile(sourceFile, cwd);

    expect(clonedFile).not.toBe(sourceFile);
    expect(fs.existsSync(clonedFile)).toBe(true);
    const reopened = SessionManager.open(clonedFile, sessionDir);
    expect(reopened.getHeader()?.parentSession).toBe(sourceFile);
    expect(reopened.buildSessionContext().messages.map((message: any) => message.role)).toContain('compactionSummary');
  });
});
