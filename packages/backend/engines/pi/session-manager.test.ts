import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openOrCreatePiSessionManager } from './session-manager.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-resume-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Pi native Session resume', () => {
  it('opens the exact existing session file instead of creating a replacement', () => {
    const cwd = temporaryRoot();
    const sessionDir = path.join(cwd, '.pi', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const original = SessionManager.create(cwd, sessionDir);
    const sessionFile = original.getSessionFile();
    expect(sessionFile).toBeTruthy();
    original.appendCustomEntry('resume-test', { preserved: true });
    fs.writeFileSync(
      sessionFile!,
      [original.getHeader(), ...original.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    const resumed = openOrCreatePiSessionManager({
      sessionId: 'tower-session',
      cwd,
      engineSessionId: sessionFile!,
    });

    expect(resumed.sessionMgr.getSessionFile()).toBe(sessionFile);
    expect(resumed.resumeFailedMsg).toBeNull();
  });

  it('fails closed when the requested native session file cannot be restored', () => {
    const cwd = temporaryRoot();
    const missing = path.join(cwd, '.pi', 'sessions', 'missing.jsonl');

    expect(() => openOrCreatePiSessionManager({
      sessionId: 'tower-session',
      cwd,
      engineSessionId: missing,
    })).toThrow('session file or backup is missing');

    const sessionDir = path.join(cwd, '.pi', 'sessions');
    const files = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
    expect(files).toEqual([]);
  });
});
