import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'ws-handler.ts'), 'utf8');

describe('normal session completion notification wiring', () => {
  it('emits a policy-controlled session.completed notification after persisting engine_done metadata', () => {
    expect(source).toContain("import { notify } from '../services/notification-hub.js';");
    expect(source).toMatch(/await updateSession\(sessionId, updates\);[\s\S]*completedForSideEffects && client\.userId[\s\S]*void notify\([\s\S]*'session\.completed'/);
    expect(source).toContain('actionUrl: `/s/${currentSession.shortCode || sessionId}`');
    expect(source).toMatch(/notify\([\s\S]*\)\.catch\(\(err: any\) => \{/);
  });
});
