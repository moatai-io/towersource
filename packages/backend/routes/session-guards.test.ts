import { describe, it, expect } from 'vitest';
import {
  isEpochStale,
  findSessionClient,
  addSessionClient,
  removeSessionClient,
  switchSession,
  abortCleanup,
  type SessionClient,
} from './session-guards';

function makeClient(overrides: Partial<SessionClient> = {}): SessionClient {
  return { id: 'c1', activeQueryEpoch: 1, ...overrides };
}

describe('isEpochStale', () => {
  it('returns false when epoch matches (loop should continue)', () => {
    const client = makeClient({ activeQueryEpoch: 5 });
    expect(isEpochStale(client, 5)).toBe(false);
  });

  it('returns true when epoch differs (loop should stop)', () => {
    const client = makeClient({ activeQueryEpoch: 6 });
    expect(isEpochStale(client, 5)).toBe(true);
  });
});

describe('addSessionClient / removeSessionClient', () => {
  it('adds client to a new session set', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    expect(sc.get('s1')?.has('c1')).toBe(true);
  });

  it('adds multiple clients to the same session', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    addSessionClient(sc, 's1', 'c2');
    expect(sc.get('s1')?.size).toBe(2);
  });

  it('removes client and cleans up empty set', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    removeSessionClient(sc, 's1', 'c1');
    expect(sc.has('s1')).toBe(false);
  });

  it('keeps set when other clients remain', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    addSessionClient(sc, 's1', 'c2');
    removeSessionClient(sc, 's1', 'c1');
    expect(sc.get('s1')?.size).toBe(1);
    expect(sc.get('s1')?.has('c2')).toBe(true);
  });
});

describe('findSessionClient', () => {
  it('returns client when found in session set', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    const client = makeClient({ id: 'c1', sessionId: 's1' });
    const clients = new Map([['c1', client]]);

    const result = findSessionClient(sc, clients, 's1');
    expect(result).toBe(client);
  });

  it('returns first live client from multiple viewers', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    addSessionClient(sc, 's1', 'c2');
    const c1 = makeClient({ id: 'c1', sessionId: 's1' });
    const c2 = makeClient({ id: 'c2', sessionId: 's1' });
    const clients = new Map([['c1', c1], ['c2', c2]]);

    const result = findSessionClient(sc, clients, 's1');
    expect(result).toBeDefined();
    expect(result!.sessionId).toBe('s1');
  });

  it('returns undefined when no clients exist', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    const clients = new Map<string, SessionClient>();

    const result = findSessionClient(sc, clients, 's1');
    expect(result).toBeUndefined();
  });

  it('returns undefined for unmapped session', () => {
    const sc = new Map<string, Set<string>>();
    const clients = new Map<string, SessionClient>();

    const result = findSessionClient(sc, clients, 's1');
    expect(result).toBeUndefined();
  });

  it('skips clients that switched to a different session', () => {
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    const client = makeClient({ id: 'c1', sessionId: 's2' }); // switched away
    const clients = new Map([['c1', client]]);

    const result = findSessionClient(sc, clients, 's1');
    expect(result).toBeUndefined();
  });
});

describe('switchSession', () => {
  it('removes from old set, bumps epoch, adds to new set', () => {
    const client = makeClient({ id: 'c1', sessionId: 'old-s', activeQueryEpoch: 3 });
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 'old-s', 'c1');

    const newEpoch = switchSession(client, sc, 'old-s', 'new-s');

    expect(sc.has('old-s')).toBe(false);
    expect(sc.get('new-s')?.has('c1')).toBe(true);
    expect(newEpoch).toBe(4);
    expect(client.sessionId).toBe('new-s');
  });

  it('preserves other clients in old session set', () => {
    const client = makeClient({ id: 'c1', sessionId: 'old-s', activeQueryEpoch: 1 });
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 'old-s', 'c1');
    addSessionClient(sc, 'old-s', 'c2'); // another tab viewing old-s

    switchSession(client, sc, 'old-s', 'new-s');

    // c2 still in old-s
    expect(sc.get('old-s')?.has('c2')).toBe(true);
    expect(sc.get('old-s')?.has('c1')).toBe(false);
    // c1 in new-s
    expect(sc.get('new-s')?.has('c1')).toBe(true);
  });

  it('still bumps epoch when oldSessionId === newSessionId', () => {
    const client = makeClient({ id: 'c1', sessionId: 's1', activeQueryEpoch: 5 });
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');

    const newEpoch = switchSession(client, sc, 's1', 's1');

    expect(newEpoch).toBe(6);
    expect(sc.get('s1')?.has('c1')).toBe(true);
  });

  it('handles undefined oldSessionId (first connection)', () => {
    const client = makeClient({ id: 'c1', activeQueryEpoch: 0 });
    const sc = new Map<string, Set<string>>();

    const newEpoch = switchSession(client, sc, undefined, 'new-s');

    expect(newEpoch).toBe(1);
    expect(client.sessionId).toBe('new-s');
    expect(sc.get('new-s')?.has('c1')).toBe(true);
  });
});

describe('abortCleanup', () => {
  it('bumps epoch and removes from session set', () => {
    const client = makeClient({ id: 'c1', activeQueryEpoch: 2 });
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');

    const newEpoch = abortCleanup(client, sc, 's1');

    expect(newEpoch).toBe(3);
    expect(sc.has('s1')).toBe(false);
  });

  it('preserves other clients in session set', () => {
    const client = makeClient({ id: 'c1', activeQueryEpoch: 2 });
    const sc = new Map<string, Set<string>>();
    addSessionClient(sc, 's1', 'c1');
    addSessionClient(sc, 's1', 'c2');

    abortCleanup(client, sc, 's1');

    expect(sc.get('s1')?.has('c2')).toBe(true);
    expect(sc.get('s1')?.has('c1')).toBe(false);
  });
});
