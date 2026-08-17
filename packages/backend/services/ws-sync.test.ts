import { describe, it, expect, vi } from 'vitest';
import { dispatchWsSyncEnvelope, parseWsSyncPayload, type WsSyncEnvelope } from './ws-sync';

describe('parseWsSyncPayload', () => {
  it('parses a valid payload', () => {
    const parsed = parseWsSyncPayload(JSON.stringify({
      origin: 'server-a',
      scope: 'session',
      sessionId: 's1',
      data: { type: 'sdk_message' },
    }));

    expect(parsed).toEqual({
      origin: 'server-a',
      scope: 'session',
      sessionId: 's1',
      data: { type: 'sdk_message' },
    });
  });

  it('returns null for invalid json or envelope shape', () => {
    expect(parseWsSyncPayload('{oops')).toBeNull();
    expect(parseWsSyncPayload(JSON.stringify({ nope: true }))).toBeNull();
  });
});

describe('dispatchWsSyncEnvelope', () => {
  it('ignores same-origin events', () => {
    const handlers = {
      all: vi.fn(),
      session: vi.fn(),
      room: vi.fn(),
      user: vi.fn(),
    };

    const envelope: WsSyncEnvelope = {
      origin: 'server-a',
      scope: 'all',
      data: { type: 'session_status' },
    };

    dispatchWsSyncEnvelope(envelope, 'server-a', handlers);
    expect(handlers.all).not.toHaveBeenCalled();
  });

  it('dispatches each scope to the matching handler', () => {
    const handlers = {
      all: vi.fn(),
      session: vi.fn(),
      room: vi.fn(),
      user: vi.fn(),
    };

    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'all', data: { a: 1 } }, 'server-b', handlers);
    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'session', sessionId: 's1', data: { b: 2 } }, 'server-b', handlers);
    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'room', roomId: 'r1', data: { c: 3 } }, 'server-b', handlers);
    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'user', userId: 7, data: { d: 4 } }, 'server-b', handlers);

    expect(handlers.all).toHaveBeenCalledWith({ a: 1 });
    expect(handlers.session).toHaveBeenCalledWith('s1', { b: 2 });
    expect(handlers.room).toHaveBeenCalledWith('r1', { c: 3 });
    expect(handlers.user).toHaveBeenCalledWith(7, { d: 4 });
  });

  it('ignores malformed scoped envelopes', () => {
    const handlers = {
      all: vi.fn(),
      session: vi.fn(),
      room: vi.fn(),
      user: vi.fn(),
    };

    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'session', data: { bad: true } } as any, 'server-b', handlers);
    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'room', data: { bad: true } } as any, 'server-b', handlers);
    dispatchWsSyncEnvelope({ origin: 'server-a', scope: 'user', data: { bad: true } } as any, 'server-b', handlers);

    expect(handlers.session).not.toHaveBeenCalled();
    expect(handlers.room).not.toHaveBeenCalled();
    expect(handlers.user).not.toHaveBeenCalled();
  });
});
