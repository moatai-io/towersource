import { describe, it, expect } from 'vitest';
import { computeUrl, parseUrl, findSessionByKey } from './useUrlSync';
import type { SessionMeta } from '@tower/shared';

// Test fixtures — 형식 규칙을 명확히 보여주는 사례.
const UUID = '2dcf72ae-c57e-4657-8c38-aaf6001c4a76';
const SHORT = 'k4m2p9xq'; // 8자 base32 (알파벳 안, 모호문자 없음)
const ROOM_SHORT = 'rzn8wxqd';
const ROOM_UUID = '11111111-1111-4111-8111-111111111111';

describe('computeUrl', () => {
  it('home when nothing active', () => {
    expect(computeUrl(null, null, 'chat')).toBe('/');
  });

  it('session path for chat view (short_code)', () => {
    expect(computeUrl(SHORT, null, 'chat')).toBe(`/s/${SHORT}`);
  });

  it('session path for chat view (UUID — 옛 링크 호환)', () => {
    expect(computeUrl(UUID, null, 'chat')).toBe(`/s/${UUID}`);
  });

  it('files view is not serialized (treated as default)', () => {
    expect(computeUrl(SHORT, null, 'files')).toBe(`/s/${SHORT}`);
    expect(computeUrl(null, null, 'files')).toBe('/');
  });

  it('global view becomes ?view= with a session', () => {
    expect(computeUrl(SHORT, null, 'kanban')).toBe(`/s/${SHORT}?view=kanban`);
  });

  it('global view becomes ?view= without a session', () => {
    expect(computeUrl(null, null, 'inbox')).toBe('/?view=inbox');
  });

  it('rooms view + roomKey → /r/<key> (path encode)', () => {
    expect(computeUrl(null, ROOM_SHORT, 'rooms')).toBe(`/r/${ROOM_SHORT}`);
  });

  it('rooms view + roomKey + sessionKey 동시 — rooms 우선 (path)', () => {
    // activeView 가 rooms 면 채널 화면이 보임 → URL 도 채널 우선
    expect(computeUrl(SHORT, ROOM_SHORT, 'rooms')).toBe(`/r/${ROOM_SHORT}`);
  });

  it('rooms view 인데 특정 채널 미지정 → /?view=rooms', () => {
    expect(computeUrl(null, null, 'rooms')).toBe('/?view=rooms');
  });

  it('serializes system tab as query param', () => {
    expect(computeUrl(null, null, 'chat', 'publishing')).toBe('/?system=publishing');
    expect(computeUrl(SHORT, null, 'chat', 'publishing')).toBe(`/s/${SHORT}?system=publishing`);
    expect(computeUrl(SHORT, null, 'kanban', 'publishing')).toBe(`/s/${SHORT}?view=kanban&system=publishing`);
  });

  it('rooms 가 아닌 다른 view 면 roomKey 가 있어도 무시되고 세션 우선', () => {
    expect(computeUrl(SHORT, ROOM_SHORT, 'kanban')).toBe(`/s/${SHORT}?view=kanban`);
  });

  it.each(['kanban', 'history', 'inbox', 'work', 'schedules', 'automations', 'beta'] as const)(
    'serializes global view %s (rooms 제외)',
    (view) => {
      expect(computeUrl(null, null, view)).toBe(`/?view=${view}`);
    },
  );
});

describe('parseUrl', () => {
  it('extracts UUID from /s/:uuid (옛 링크)', () => {
    expect(parseUrl(`/s/${UUID}`, '')).toEqual({ sessionKey: UUID, roomKey: null, view: null, systemTab: null });
  });

  it('extracts short_code from /s/:code (Phase 2 권장)', () => {
    expect(parseUrl(`/s/${SHORT}`, '')).toEqual({ sessionKey: SHORT, roomKey: null, view: null, systemTab: null });
  });

  it('extracts roomKey from /r/:code', () => {
    expect(parseUrl(`/r/${ROOM_SHORT}`, '')).toEqual({
      sessionKey: null,
      roomKey: ROOM_SHORT,
      view: 'rooms',
      systemTab: null,
    });
  });

  it('extracts roomKey from /r/:uuid (옛 링크 호환)', () => {
    expect(parseUrl(`/r/${ROOM_UUID}`, '')).toEqual({
      sessionKey: null,
      roomKey: ROOM_UUID,
      view: 'rooms',
      systemTab: null,
    });
  });

  it('/r/<key> 는 view query 무시 (path 가 rooms 강제)', () => {
    expect(parseUrl(`/r/${ROOM_SHORT}`, '?view=kanban')).toEqual({
      sessionKey: null,
      roomKey: ROOM_SHORT,
      view: 'rooms',
      systemTab: null,
    });
  });

  it('null keys on home', () => {
    expect(parseUrl('/', '')).toEqual({ sessionKey: null, roomKey: null, view: null, systemTab: null });
  });

  it('reads ?view= when whitelisted', () => {
    expect(parseUrl('/', '?view=kanban')).toEqual({ sessionKey: null, roomKey: null, view: 'kanban', systemTab: null });
    expect(parseUrl('/', '?view=beta')).toEqual({ sessionKey: null, roomKey: null, view: 'beta', systemTab: null });
    expect(parseUrl('/', '?view=work')).toEqual({ sessionKey: null, roomKey: null, view: 'work', systemTab: null });
    expect(parseUrl(`/s/${SHORT}`, '?view=inbox')).toEqual({
      sessionKey: SHORT,
      roomKey: null,
      view: 'inbox',
      systemTab: null,
    });
  });


  it('reads ?system=publishing', () => {
    expect(parseUrl('/', '?system=publishing')).toEqual({ sessionKey: null, roomKey: null, view: null, systemTab: 'publishing' });
    expect(parseUrl(`/s/${SHORT}`, '?system=publishing')).toEqual({ sessionKey: SHORT, roomKey: null, view: null, systemTab: 'publishing' });
    expect(parseUrl(`/s/${SHORT}`, '?view=kanban&system=publishing')).toEqual({ sessionKey: SHORT, roomKey: null, view: 'kanban', systemTab: 'publishing' });
  });

  it('ignores unknown system values', () => {
    expect(parseUrl('/', '?system=bogus')).toEqual({ sessionKey: null, roomKey: null, view: null, systemTab: null });
  });

  it('ignores non-whitelisted view values', () => {
    expect(parseUrl('/', '?view=chat')).toEqual({ sessionKey: null, roomKey: null, view: null, systemTab: null });
    expect(parseUrl('/', '?view=bogus')).toEqual({ sessionKey: null, roomKey: null, view: null, systemTab: null });
    expect(parseUrl('/', '?view=files')).toEqual({ sessionKey: null, roomKey: null, view: null, systemTab: null });
  });

  it('does not match non-deep-link paths', () => {
    expect(parseUrl('/file-viewer', '').sessionKey).toBeNull();
    expect(parseUrl('/file-viewer', '').roomKey).toBeNull();
    expect(parseUrl('/shared/tok', '').sessionKey).toBeNull();
    expect(parseUrl(`/s/${SHORT}/extra`, '').sessionKey).toBeNull();
    expect(parseUrl(`/r/${ROOM_SHORT}/extra`, '').roomKey).toBeNull();
  });

  it('rejects malformed keys (7자, 9자, 임의 문자열)', () => {
    expect(parseUrl('/s/k4m2p9x', '').sessionKey).toBeNull();
    expect(parseUrl('/s/k4m2p9xqq', '').sessionKey).toBeNull();
    expect(parseUrl('/r/k4m2p9x', '').roomKey).toBeNull();
  });

  it('round-trips with computeUrl', () => {
    const cases: Array<{
      sessionKey: string | null;
      roomKey: string | null;
      view: Parameters<typeof computeUrl>[2];
    }> = [
      { sessionKey: null, roomKey: null, view: 'chat' },
      { sessionKey: SHORT, roomKey: null, view: 'chat' },
      { sessionKey: SHORT, roomKey: null, view: 'kanban' },
      { sessionKey: UUID, roomKey: null, view: 'chat' },
      { sessionKey: null, roomKey: null, view: 'inbox' },
      { sessionKey: null, roomKey: ROOM_SHORT, view: 'rooms' },
      { sessionKey: null, roomKey: ROOM_UUID, view: 'rooms' },
    ];
    for (const { sessionKey, roomKey, view } of cases) {
      const url = computeUrl(sessionKey, roomKey, view);
      const [path, search] = url.split('?');
      const parsed = parseUrl(path, search ? `?${search}` : '');
      expect(parsed.sessionKey).toBe(sessionKey);
      expect(parsed.roomKey).toBe(roomKey);
      expect(parsed.view).toBe(view === 'chat' || view === 'files' ? null : view);
    }
  });
});

describe('findSessionByKey', () => {
  const sessions: SessionMeta[] = [
    {
      id: UUID,
      shortCode: SHORT,
      name: 'session A',
      cwd: '/x',
      tags: [],
      favorite: false,
      totalCost: 0,
      totalTokens: 0,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'legacy session',
      cwd: '/z',
      tags: [],
      favorite: false,
      totalCost: 0,
      totalTokens: 0,
      createdAt: '',
      updatedAt: '',
    },
  ];

  it('matches by UUID', () => {
    expect(findSessionByKey(sessions, UUID)?.name).toBe('session A');
  });

  it('matches by shortCode', () => {
    expect(findSessionByKey(sessions, SHORT)?.name).toBe('session A');
  });

  it('case-insensitive', () => {
    expect(findSessionByKey(sessions, UUID.toUpperCase())?.name).toBe('session A');
    expect(findSessionByKey(sessions, 'K4M2P9XQ')?.name).toBe('session A');
  });

  it('legacy session 매칭 (shortCode 없음)', () => {
    expect(findSessionByKey(sessions, '22222222-2222-4222-8222-222222222222')?.name).toBe('legacy session');
  });

  it('returns undefined for unknown key', () => {
    expect(findSessionByKey(sessions, 'unknown1')).toBeUndefined();
  });
});
