/**
 * oauth-store-pg.ts — PostgreSQL implementation of OAuthStore.
 *
 * Used in production. Tests use in-memory store instead.
 */

import { query, queryOne, execute } from '../../db/pg-repo.js';
import type { OAuthStore, OAuthToken } from './oauth-manager.js';

export const pgOAuthStore: OAuthStore = {
  async save(token: OAuthToken) {
    await execute(`
      INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token,
        token_expires_at, refresh_expires_at, provider_user_id, provider_nickname, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id, provider) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, user_oauth_tokens.refresh_token),
        token_expires_at = EXCLUDED.token_expires_at,
        refresh_expires_at = COALESCE(EXCLUDED.refresh_expires_at, user_oauth_tokens.refresh_expires_at),
        provider_user_id = COALESCE(EXCLUDED.provider_user_id, user_oauth_tokens.provider_user_id),
        provider_nickname = COALESCE(EXCLUDED.provider_nickname, user_oauth_tokens.provider_nickname),
        metadata = COALESCE(EXCLUDED.metadata, user_oauth_tokens.metadata),
        updated_at = NOW()
    `, [
      token.user_id, token.provider, token.access_token, token.refresh_token,
      token.token_expires_at, token.refresh_expires_at,
      token.provider_user_id, token.provider_nickname,
      JSON.stringify(token.metadata ?? {}),
    ]);
  },

  async get(userId: number, provider: string) {
    return queryOne<OAuthToken>(
      'SELECT * FROM user_oauth_tokens WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
  },

  async delete(userId: number, provider: string) {
    await execute(
      'DELETE FROM user_oauth_tokens WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
  },

  async getProviders(userId: number) {
    const rows = await query<{ provider: string }>(
      'SELECT provider FROM user_oauth_tokens WHERE user_id = $1',
      [userId],
    );
    return rows.map(r => r.provider);
  },
};
