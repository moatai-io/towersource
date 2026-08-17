-- 056_internal_tools_slug_suffix.sql — Phase 2a-3 unlisted/public 활성화
--
-- 결정:
--   workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
--   workspace/decisions/2026-05-02-execution-sandbox-q18-public-tools.md (정책)
--
-- 추가: slug_suffix TEXT NULL
--   - unlisted visibility 시 URL 의 6자 hex suffix (`<owner>-<name>-<6hex>`).
--   - tool_start 시 unlisted 면 `openssl rand -hex 3` 으로 생성, 컬럼에 영구 저장.
--   - visibility 라운드 트립 (auth-required → unlisted → public → unlisted) 시
--     같은 suffix 재사용 — 외부 공유된 URL 깨지지 않게.
--   - auth-required / public / private 일 때는 NULL.
--
-- 049 까지의 패턴 (additive only, IF NOT EXISTS) 유지. backfill 없음 —
-- 기존 도구는 모두 auth-required 또는 private 이므로 suffix 불필요.

ALTER TABLE internal_tools
  ADD COLUMN IF NOT EXISTS slug_suffix TEXT;

-- 형식 검증: 정확히 6자 lowercase hex (openssl rand -hex 3 의 출력).
ALTER TABLE internal_tools DROP CONSTRAINT IF EXISTS internal_tools_slug_suffix_chk;
ALTER TABLE internal_tools ADD CONSTRAINT internal_tools_slug_suffix_chk CHECK (
  slug_suffix IS NULL OR slug_suffix ~ '^[a-f0-9]{6}$'
);

COMMENT ON COLUMN internal_tools.slug_suffix IS
  'Unlisted visibility 의 6자 hex suffix. URL = <owner>-<name>-<suffix>.<domain>. '
  'visibility 라운드 트립 시 재사용 — 외부 공유 URL 안정성. '
  '결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md';
