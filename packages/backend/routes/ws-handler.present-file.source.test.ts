import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const WS_HANDLER_PATH = path.resolve(import.meta.dirname, './ws-handler.ts');

describe('ws-handler present_file delivery contract', () => {
  it('broadcasts only successful present_file intents on the authenticated user scope', () => {
    const src = fs.readFileSync(WS_HANDLER_PATH, 'utf-8');
    expect(src).toContain("parsed?.action !== 'present_file'");
    expect(src).toContain("type: 'present_file_intent'");
    expect(src).toContain('deliveryId,');
    expect(src).toContain('sessionId, toolUseId, result');
    expect(src).toContain('broadcastToUser(userId');
    expect(src).toContain('broadcastPresentFileIntent(client.userId, sessionId, toolUseId, result)');
    expect(src).toContain('broadcastPresentFileIntent(userId, sessionId, toolUseId, result)');
  });
});
