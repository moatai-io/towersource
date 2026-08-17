-- ============================================================
-- 061: username 변경 audit 테이블
-- ============================================================
-- 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
--
-- username 은 라벨일 뿐 모든 FK 가 users.id (정수) 기준이라 안전하게 바꿀 수 있다.
-- 다만 옛 결정문서·산출물에 박힌 옛 username 이 누구였는지 매핑할 흔적이 필요.
-- changed_by 가 NULL 가능한 이유: 1회성 마이그레이션 스크립트 (시스템) 가 박는 경우.

CREATE TABLE IF NOT EXISTS user_username_history (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_username    TEXT NOT NULL,
  new_username    TEXT NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      INTEGER REFERENCES users(id),
  reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_uuh_user_id      ON user_username_history(user_id);
CREATE INDEX IF NOT EXISTS idx_uuh_old_username ON user_username_history(old_username);

COMMENT ON TABLE user_username_history IS 'username 변경 이력. 옛 username 으로 결정문서/산출물을 검색했을 때 누구였는지 매핑.';
