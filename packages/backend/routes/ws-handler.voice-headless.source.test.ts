import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const handler = fs.readFileSync(path.resolve('packages/backend/routes/ws-handler.ts'), 'utf8');
const gateway = fs.readFileSync(path.resolve('packages/backend/services/voice-runtime/tower-session-turn-gateway.ts'), 'utf8');

describe('headless Tower turns', () => {
  it('does not register synthetic voice clients as live session viewers', () => {
    expect(handler).toContain('headless?: boolean');
    expect(handler).toContain('if (!data.headless) addSessionClient(sessionClients, sessionId, client.id);');
    expect(gateway).toContain('headless: true');
  });
});
