/**
 * oauth-manager.test.ts — TDD Red phase
 *
 * Tests for OAuth token lifecycle: save, get, delete, refresh, getValidToken.
 * Uses in-memory store (no DB dependency).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createOAuthManager,
  type OAuthStore,
  type OAuthToken,
} from './oauth-manager';

// ── In-memory store for testing (no DB) ──

function makeMemoryStore(): OAuthStore {
  const tokens = new Map<string, OAuthToken>(); // key: `${userId}:${provider}`

  return {
    async save(token) {
      const key = `${token.user_id}:${token.provider}`;
      const existing = tokens.get(key);
      tokens.set(key, {
        ...existing,
        ...token,
        // COALESCE semantics: keep old value if new is null
        refresh_token: token.refresh_token ?? existing?.refresh_token ?? null,
        provider_user_id: token.provider_user_id ?? existing?.provider_user_id ?? null,
        provider_nickname: token.provider_nickname ?? existing?.provider_nickname ?? null,
      });
    },
    async get(userId, provider) {
      return tokens.get(`${userId}:${provider}`) ?? undefined;
    },
    async delete(userId, provider) {
      tokens.delete(`${userId}:${provider}`);
    },
    async getProviders(userId) {
      const result: string[] = [];
      for (const [key] of tokens) {
        const [uid, prov] = key.split(':');
        if (uid === String(userId)) result.push(prov);
      }
      return result;
    },
  };
}

// ── Tests ──

describe('OAuthManager', () => {
  let store: OAuthStore;
  let manager: ReturnType<typeof createOAuthManager>;

  beforeEach(() => {
    store = makeMemoryStore();
    manager = createOAuthManager(store);
  });

  // ── saveToken / getToken ──

  describe('saveToken / getToken', () => {
    it('saves and retrieves a token', async () => {
      await manager.saveToken({
        userId: 1,
        provider: 'kakao',
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresIn: 43199,
        refreshExpiresIn: 5184000,
      });

      const token = await manager.getToken(1, 'kakao');
      expect(token).toBeDefined();
      expect(token!.access_token).toBe('access-123');
      expect(token!.refresh_token).toBe('refresh-456');
      expect(token!.token_expires_at).toBeGreaterThan(Date.now());
    });

    it('upserts on same userId+provider', async () => {
      await manager.saveToken({
        userId: 1, provider: 'kakao',
        accessToken: 'old-token',
      });
      await manager.saveToken({
        userId: 1, provider: 'kakao',
        accessToken: 'new-token',
      });

      const token = await manager.getToken(1, 'kakao');
      expect(token!.access_token).toBe('new-token');
    });

    it('preserves refresh_token when new save omits it', async () => {
      await manager.saveToken({
        userId: 1, provider: 'kakao',
        accessToken: 'a1', refreshToken: 'r1',
      });
      await manager.saveToken({
        userId: 1, provider: 'kakao',
        accessToken: 'a2', // no refreshToken
      });

      const token = await manager.getToken(1, 'kakao');
      expect(token!.access_token).toBe('a2');
      expect(token!.refresh_token).toBe('r1'); // preserved
    });

    it('returns undefined for non-existent token', async () => {
      const token = await manager.getToken(999, 'kakao');
      expect(token).toBeUndefined();
    });
  });

  // ── deleteToken ──

  describe('deleteToken', () => {
    it('removes the token', async () => {
      await manager.saveToken({ userId: 1, provider: 'kakao', accessToken: 'x' });
      await manager.deleteToken(1, 'kakao');
      expect(await manager.getToken(1, 'kakao')).toBeUndefined();
    });

    it('is safe to delete non-existent token', async () => {
      await expect(manager.deleteToken(999, 'kakao')).resolves.not.toThrow();
    });
  });

  // ── getConnectedProviders ──

  describe('getConnectedProviders', () => {
    it('returns empty array when no tokens', async () => {
      expect(await manager.getConnectedProviders(1)).toEqual([]);
    });

    it('returns all connected providers', async () => {
      await manager.saveToken({ userId: 1, provider: 'kakao', accessToken: 'a' });
      await manager.saveToken({ userId: 1, provider: 'slack', accessToken: 'b' });

      const providers = await manager.getConnectedProviders(1);
      expect(providers).toContain('kakao');
      expect(providers).toContain('slack');
      expect(providers).toHaveLength(2);
    });

    it('does not leak tokens from other users', async () => {
      await manager.saveToken({ userId: 1, provider: 'kakao', accessToken: 'a' });
      await manager.saveToken({ userId: 2, provider: 'slack', accessToken: 'b' });

      expect(await manager.getConnectedProviders(1)).toEqual(['kakao']);
    });
  });

  // ── Token refresh ──

  describe('getValidToken', () => {
    it('returns access_token when not expired', async () => {
      await manager.saveToken({
        userId: 1, provider: 'kakao',
        accessToken: 'valid-token',
        expiresIn: 43199, // 12h from now
      });

      const token = await manager.getValidToken(1, 'kakao');
      expect(token).toBe('valid-token');
    });

    it('refreshes when token is expired', async () => {
      // Save a token that already expired
      await store.save({
        id: 'test',
        user_id: 1,
        provider: 'kakao',
        access_token: 'expired-token',
        refresh_token: 'refresh-123',
        token_expires_at: Date.now() - 60_000, // expired 1min ago
        refresh_expires_at: Date.now() + 86400_000,
        provider_user_id: null,
        provider_nickname: null,
        metadata: {},
      });

      // Register a mock refresher
      const refreshFn = vi.fn().mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 43199,
      });
      manager.registerRefresher('kakao', refreshFn);

      const token = await manager.getValidToken(1, 'kakao');
      expect(token).toBe('new-access-token');
      expect(refreshFn).toHaveBeenCalledWith('refresh-123');

      // Verify saved in store
      const stored = await manager.getToken(1, 'kakao');
      expect(stored!.access_token).toBe('new-access-token');
    });

    it('refreshes when token expires within 5 minutes', async () => {
      await store.save({
        id: 'test',
        user_id: 1,
        provider: 'kakao',
        access_token: 'about-to-expire',
        refresh_token: 'refresh-123',
        token_expires_at: Date.now() + 120_000, // expires in 2min (within 5min buffer)
        refresh_expires_at: null,
        provider_user_id: null,
        provider_nickname: null,
        metadata: {},
      });

      const refreshFn = vi.fn().mockResolvedValue({
        accessToken: 'refreshed',
        expiresIn: 43199,
      });
      manager.registerRefresher('kakao', refreshFn);

      const token = await manager.getValidToken(1, 'kakao');
      expect(token).toBe('refreshed');
    });

    it('throws when no token exists', async () => {
      await expect(manager.getValidToken(999, 'kakao'))
        .rejects.toThrow('No kakao token for user 999');
    });

    it('throws when expired and no refresh_token', async () => {
      await store.save({
        id: 'test',
        user_id: 1,
        provider: 'kakao',
        access_token: 'expired',
        refresh_token: null,
        token_expires_at: Date.now() - 60_000,
        refresh_expires_at: null,
        provider_user_id: null,
        provider_nickname: null,
        metadata: {},
      });

      await expect(manager.getValidToken(1, 'kakao'))
        .rejects.toThrow('token expired, no refresh token');
    });

    it('throws when expired and no refresher registered', async () => {
      await store.save({
        id: 'test',
        user_id: 1,
        provider: 'kakao',
        access_token: 'expired',
        refresh_token: 'has-refresh',
        token_expires_at: Date.now() - 60_000,
        refresh_expires_at: null,
        provider_user_id: null,
        provider_nickname: null,
        metadata: {},
      });

      await expect(manager.getValidToken(1, 'kakao'))
        .rejects.toThrow('No refresher registered for kakao');
    });
  });
});
