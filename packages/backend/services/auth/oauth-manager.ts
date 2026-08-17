/**
 * oauth-manager.ts — OAuth token lifecycle management.
 *
 * Provider-agnostic: works with Kakao, Slack, Telegram, etc.
 * Uses dependency injection for storage (DB in prod, in-memory in tests).
 */

// ── Types ──

export interface OAuthToken {
  id: string;
  user_id: number;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: number | null;   // Unix timestamp (ms)
  refresh_expires_at: number | null; // Unix timestamp (ms)
  provider_user_id: string | null;
  provider_nickname: string | null;
  metadata: Record<string, any>;
}

/** Storage abstraction — swap DB for in-memory in tests */
export interface OAuthStore {
  save(token: OAuthToken): Promise<void>;
  get(userId: number, provider: string): Promise<OAuthToken | undefined>;
  delete(userId: number, provider: string): Promise<void>;
  getProviders(userId: number): Promise<string[]>;
}

export type RefreshFn = (refreshToken: string) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
}>;

// ── Factory ──

export function createOAuthManager(store: OAuthStore) {
  const refreshers = new Map<string, RefreshFn>();

  return {
    async saveToken(params: {
      userId: number;
      provider: string;
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;        // seconds
      refreshExpiresIn?: number; // seconds
      providerUserId?: string;
      providerNickname?: string;
      metadata?: Record<string, any>;
    }): Promise<void> {
      const now = Date.now();
      const tokenExpiresAt = params.expiresIn ? now + params.expiresIn * 1000 : null;
      const refreshExpiresAt = params.refreshExpiresIn ? now + params.refreshExpiresIn * 1000 : null;

      await store.save({
        id: '',  // DB generates
        user_id: params.userId,
        provider: params.provider,
        access_token: params.accessToken,
        refresh_token: params.refreshToken ?? null,
        token_expires_at: tokenExpiresAt,
        refresh_expires_at: refreshExpiresAt,
        provider_user_id: params.providerUserId ?? null,
        provider_nickname: params.providerNickname ?? null,
        metadata: params.metadata ?? {},
      });
    },

    async getToken(userId: number, provider: string): Promise<OAuthToken | undefined> {
      return store.get(userId, provider);
    },

    async deleteToken(userId: number, provider: string): Promise<void> {
      return store.delete(userId, provider);
    },

    async getConnectedProviders(userId: number): Promise<string[]> {
      return store.getProviders(userId);
    },

    registerRefresher(provider: string, fn: RefreshFn) {
      refreshers.set(provider, fn);
    },

    /**
     * Get a valid access token. If expired (or expiring within 5min), refresh automatically.
     * Throws if no token found or refresh fails.
     */
    async getValidToken(userId: number, provider: string): Promise<string> {
      const token = await store.get(userId, provider);
      if (!token) throw new Error(`No ${provider} token for user ${userId}`);

      const now = Date.now();
      const BUFFER = 300_000; // 5 minutes

      // Token still valid?
      if (!token.token_expires_at || token.token_expires_at - BUFFER > now) {
        return token.access_token;
      }

      // Needs refresh
      if (!token.refresh_token) {
        throw new Error(`${provider} token expired, no refresh token`);
      }

      const refreshFn = refreshers.get(provider);
      if (!refreshFn) {
        throw new Error(`No refresher registered for ${provider}`);
      }

      const refreshed = await refreshFn(token.refresh_token);
      await this.saveToken({
        userId,
        provider,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresIn: refreshed.expiresIn,
        refreshExpiresIn: refreshed.refreshExpiresIn,
      });

      return refreshed.accessToken;
    },
  };
}
