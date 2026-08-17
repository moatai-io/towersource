import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, '../App.tsx'), 'utf8');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, './useChatRuntime.ts'), 'utf8');
const socket = fs.readFileSync(path.resolve(import.meta.dirname, './useWebSocket.ts'), 'utf8');

describe('authenticated WebSocket boot contract', () => {
  it('does not open an anonymous socket while an auth-enabled login is unresolved', () => {
    expect(app).toContain('useChatRuntime(authStatus?.authEnabled === false || !!token)');
    expect(runtime).toContain('export function useChatRuntime(wsEnabled = true)');
    expect(runtime).toMatch(/const wsUrl = wsEnabled \? .* : null/);
    expect(socket).toContain('export function useWebSocket(url: string | null');
    expect(socket).toContain('if (!url) return;');
  });
});
