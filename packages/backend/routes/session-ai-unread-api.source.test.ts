import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve('packages/backend/routes/api.ts'), 'utf8');

describe('Session AI-response subscription API', () => {
  it('requires normal Session access before changing subscription', () => {
    const route = source.slice(source.indexOf("router.put('/sessions/:id/subscription'"), source.indexOf("router.put('/sessions/:id/read-ai-response'"));
    expect(route).toContain("typeof req.body?.subscribed !== 'boolean'");
    expect(route).toContain('await canAccessSession(sessionId, userId, role)');
    expect(route).toContain('await setSessionSubscription(userId, sessionId, req.body.subscribed)');
    expect(route).toContain('await getSessionUserState(userId, sessionId)');
  });

  it('validates and access-checks monotonic read cursor writes', () => {
    const route = source.slice(source.indexOf("router.put('/sessions/:id/read-ai-response'"), source.indexOf("router.post('/sessions/:id/project-agent-profile/latest'"));
    expect(route).toContain('Number.isSafeInteger(sequence)');
    expect(route).toContain('sequence < 0');
    expect(route).toContain('await canAccessSession(sessionId, userId, role)');
    expect(route).toContain('await markAiResponseRead(userId, sessionId, sequence)');
  });
});
