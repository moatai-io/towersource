import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HOOK_PATH = path.resolve(import.meta.dirname, './useWebSocket.ts');

describe('useWebSocket source contracts', () => {
  it('does not open a competing socket while one is connecting', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/readyState === WebSocket\.OPEN[\s\S]*readyState === WebSocket\.CONNECTING/);
    expect(src).toMatch(/if \(wsRef\.current !== ws\) return;/);
  });

  it('queues chat frames during a reconnect and flushes them on open', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/PENDING_CHAT_FRAME_MAX = 5/);
    expect(src).toMatch(/pendingChatFrames\.current\.push\(data\)/);
    expect(src).toMatch(/pendingChatFrames\.current\.splice\(0\)/);
    expect(src).toMatch(/return 'queued'/);
  });
});
