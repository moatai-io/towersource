/**
 * oauth-manager-instance.ts — Owns: 싱글톤 OAuth 매니저 인스턴스 (google 전용).
 *
 * Public API: `oauthManager` (createOAuthManager(pgOAuthStore) + google refresher).
 *
 * 들어오기 전 알아야 할 것:
 *   - 과거엔 services/messaging/index.ts 가 이 인스턴스를 만들고 kakao/telegram/google
 *     refresher 를 모두 등록했다. #58 (외부 메시징 폐기) 에서 kakao/telegram 이 사라지면서,
 *     google OAuth(gws 캘린더/메일) 가 살아남도록 인스턴스를 auth/ 로 이전했다.
 *   - 이제 google refresher 만 등록한다.
 *
 * 관련 결정: workspace/decisions/2026-06-01-external-messaging-removal.md (#58 Phase 3)
 */

import { createOAuthManager } from './oauth-manager.js';
import { pgOAuthStore } from './oauth-store-pg.js';
import { isGoogleOAuthConfigured, createGoogleRefresher } from './google-oauth.js';

/** 싱글톤 OAuth 매니저 (PostgreSQL store, google refresher). */
export const oauthManager = createOAuthManager(pgOAuthStore);

if (isGoogleOAuthConfigured()) {
  oauthManager.registerRefresher('google', createGoogleRefresher());
}
