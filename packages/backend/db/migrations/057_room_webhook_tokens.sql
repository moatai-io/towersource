-- ============================================================
-- 057: room_webhook_tokens — 외부 cron/스크립트 → Tower 룸 inbound webhook
--
-- 결정: workspace/decisions/2026-05-16-room-inbound-webhook.md
-- 첫 사용 사례: workspace/projects/hantoo/.project/decisions/
--               2026-05-16-fund-disclosure-webhook-setup.md
--
-- 토큰 raw 는 발급 시점에만 응답. DB 에는 sha256 hash 만.
-- 룸 scope (한 토큰 = 한 룸).
-- revoked_at NOT NULL → 즉시 무효화.
-- 토큰 prefix `twrh_` (Tower webhook) — GitHub secret scanning 등록 가능.
--
-- room_messages.msg_type 은 DB CHECK 없는 자유 text 컬럼이라 추가 변경 불필요.
-- 'webhook' 은 services/room/room-manager.ts 의 VALID_MSG_TYPES Set 에 추가.
-- ============================================================

CREATE TABLE IF NOT EXISTS room_webhook_tokens (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,    -- sha256 hex (64자)
  label         TEXT NOT NULL,            -- 사람 인식용 ("펀드공시 수집기" 등)
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

-- Hot lookup: 토큰 검증 시 hash 로 조회 + 활성 (revoked_at IS NULL) 필터
CREATE INDEX IF NOT EXISTS idx_room_webhook_tokens_active
  ON room_webhook_tokens(token_hash)
  WHERE revoked_at IS NULL;

-- 룸별 토큰 나열 (admin / owner UI 후속)
CREATE INDEX IF NOT EXISTS idx_room_webhook_tokens_room
  ON room_webhook_tokens(room_id, created_at DESC);

COMMENT ON TABLE room_webhook_tokens IS
  'Room-scoped inbound webhook tokens. Token raw 는 발급 시 한 번만 노출, '
  'DB 에는 sha256 hash 만. 결정: workspace/decisions/2026-05-16-room-inbound-webhook.md';
COMMENT ON COLUMN room_webhook_tokens.token_hash IS
  'sha256 hex of raw token. Raw 토큰 형식: twrh_<32 hex chars>.';
COMMENT ON COLUMN room_webhook_tokens.label IS
  '사람이 읽기 위한 라벨. 메시지 metadata.token_label 로 전파되어 UI 에 표시.';
