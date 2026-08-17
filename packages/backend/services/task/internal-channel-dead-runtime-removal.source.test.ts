import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const taskDir = import.meta.dirname;
const backend = path.resolve(taskDir, '../..');
const ws = fs.readFileSync(path.join(backend, 'routes/ws-handler.ts'), 'utf8');
const api = fs.readFileSync(path.join(backend, 'routes/api.ts'), 'utf8');
const severity = fs.readFileSync(path.join(backend, 'services/tower/severity-router.ts'), 'utf8');
const scheduler = fs.readFileSync(path.join(backend, 'services/task/unified-scheduler.ts'), 'utf8');
const roomManager = fs.readFileSync(path.join(backend, 'services/room/room-manager.ts'), 'utf8');

const removedFiles = [
  'services/room/room-guards.ts',
  'services/ai/ai-quick-reply.ts',
  'services/room/channel-authority-resolver.ts',
  'services/room/room-webhook.ts',
  'services/tower/tower-channel.ts',
  'services/cross-db.ts',
];

describe('internal Channel P6-A dead runtime removal', () => {
  it('removes transport and producer modules that no longer have an entry point', () => {
    for (const relative of removedFiles) expect(fs.existsSync(path.join(backend, relative)), relative).toBe(false);
  });

  it('keeps stable retired transport responses without legacy handlers', () => {
    expect(api).toContain("router.post('/rooms/:id/messages'");
    expect(api).toContain("code: 'INTERNAL_CHANNEL_RETIRED'");
    expect(ws).toContain("case 'room_join':");
    expect(ws).toContain("errorCode: 'INTERNAL_CHANNEL_RETIRED'");
    expect(ws).not.toMatch(/function handleRoom(Join|Leave|Message|Typing|Read)/);
    expect(ws).not.toContain('function handleShareToChannel');
  });

  it('keeps retired room sync scope as a no-op rather than a live subscriber registry', () => {
    expect(ws).not.toContain('const roomClients = new Map');
    expect(ws).not.toContain('getRoomClientIds(');
    expect(ws).not.toContain('addRoomClient(');
    expect(ws).toContain('Internal channel subscriptions are retired');
  });

  it('owns TowerSeverity outside the removed Tower channel producer', () => {
    expect(severity).toContain("export type TowerSeverity = 'L1' | 'L2' | 'L3' | 'L4'");
    expect(severity).not.toContain("from './tower-channel.js'");
    expect(scheduler).toContain('type TowerSeverity');
    expect(scheduler).not.toContain('tower-channel.js');
  });

  it('retains archive reads and sanitized webhook migration metadata', () => {
    expect(api).toContain("router.get('/rooms/:id/archive'");
    expect(api).toContain("router.get('/rooms/:id/archive/messages'");
    expect(api).toContain("router.get('/rooms/:id/webhook-tokens'");
    expect(api).not.toContain("import('../services/room/room-webhook.js')");
    expect(roomManager).not.toContain('createPgAdapter');
    expect(roomManager).not.toContain('insertRoomAiContext');
    expect(api).not.toContain('token_hash');
  });
});
