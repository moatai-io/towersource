-- 079_runtime_box_preview_proxy.sql
-- Runtime Box service preview URL/token support.
--
-- v1 preview는 같은 Tower backend 경로를 통해 auth-required path proxy 로 제공한다:
--   /api/runtime-box/preview/<preview_token>/...
-- token은 URL 안정성과 서비스 식별용이며, authMiddleware + project membership 이 실제 접근 제어다.

ALTER TABLE runtime_box_services
  ADD COLUMN IF NOT EXISTS preview_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS runtime_box_services_preview_token_unique
  ON runtime_box_services (preview_token)
  WHERE preview_token IS NOT NULL;

COMMENT ON COLUMN runtime_box_services.preview_token IS
  'Runtime Box preview path proxy token. Auth + project membership still required.';
