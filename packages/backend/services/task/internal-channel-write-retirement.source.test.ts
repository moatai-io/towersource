import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const taskDir = import.meta.dirname;
const api = fs.readFileSync(path.resolve(taskDir, '../../routes/api.ts'), 'utf8');
const ws = fs.readFileSync(path.resolve(taskDir, '../../routes/ws-handler.ts'), 'utf8');
const externalService = fs.readFileSync(path.resolve(taskDir, '../../routes/ai-service-public-api.ts'), 'utf8');


describe('internal Channel P4 write retirement', () => {
  it('returns a stable 410 for the public room inbound webhook before token mutation', () => {
    const webhook = api.slice(api.indexOf("router.post('/rooms/:id/messages'"), api.indexOf('// ───── Auth ─────'));
    expect(webhook).toContain("res.status(410).json");
    expect(webhook).toContain("code: 'INTERNAL_CHANNEL_RETIRED'");
    expect(webhook).not.toContain('verifyWebhookToken');
    expect(webhook).not.toContain('postWebhookMessage');
  });

  it('keeps a fail-closed mutation guard and removes legacy authenticated write route bodies', () => {
    const guardIndex = api.indexOf("router.use('/rooms/:id'");
    expect(guardIndex).toBeGreaterThan(-1);
    const guard = api.slice(guardIndex, api.indexOf("router.get('/rooms/:id/archive'", guardIndex));
    expect(guard).toContain("req.method === 'GET'");
    expect(guard).toContain("res.status(410).json");
    expect(guard).toContain("code: 'INTERNAL_CHANNEL_RETIRED'");
    expect(api.match(/router\.(post|patch|put|delete)\('\/rooms\/:id[^']*'/g)).toEqual([
      "router.post('/rooms/:id/messages'",
    ]);
  });

  it('keeps room archive/read routes available for P5', () => {
    for (const route of [
      "router.get('/rooms/:id'",
      "router.get('/rooms/:id/resources'",
      "router.get('/rooms/:id/shared-files'",
      "router.get('/rooms/:id/agents'",
      "router.get('/rooms/:id/membership-events'",
      "router.get('/rooms/:id/messages'",
      "router.get('/rooms/:id/webhook-tokens'",
    ]) expect(api).toContain(route);
  });

  it('rejects every room WebSocket operation without calling legacy handlers', () => {
    const roomCases = ws.slice(ws.indexOf("case 'room_join':"), ws.indexOf("case 'check_session_status':"));
    for (const type of ['room_join', 'room_leave', 'room_message', 'room_typing', 'room_read', 'share_to_channel']) {
      expect(roomCases).toContain(`case '${type}':`);
    }
    expect(roomCases).toContain("errorCode: 'INTERNAL_CHANNEL_RETIRED'");
    expect(ws).not.toContain('function handleRoomJoin(');
    expect(ws).not.toContain('function handleRoomLeave(');
    expect(ws).not.toContain('function handleRoomMessage(');
    expect(ws).not.toContain('function handleRoomTyping(');
    expect(ws).not.toContain('function handleRoomRead(');
    expect(ws).not.toContain('function handleShareToChannel(');
  });

  it('does not apply the internal retirement guard to external AI service channels', () => {
    expect(externalService).toContain('ai-service-public');
    expect(externalService).not.toContain('INTERNAL_CHANNEL_RETIRED');
  });
});
