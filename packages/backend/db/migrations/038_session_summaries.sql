-- D8 #6: Session 요약 캐시
--
-- See decisions:
--   workspace/decisions/2026-04-25-ai-native-pm-d8-issue-as-execution-hub.md
--
-- Issue detail의 Linked sessions에서 "Summarize" 버튼 클릭 시 Haiku가 2-3
-- 문장으로 요약. 매번 호출하면 비용/지연 → 24h TTL 캐시.
--
-- Tower의 memory.db에 session_summaries 가 있긴 한데 다른 시스템(Claude Code
-- 메모리 hooks)이 관리하는 거라 우리 PM 요약과 의미/용도 다름. 별도 PG 테이블.
--
-- Rollback:
--   DROP TABLE IF EXISTS pm_session_summaries;

CREATE TABLE IF NOT EXISTS pm_session_summaries (
  session_id      TEXT PRIMARY KEY,        -- sessions.id (FK 안 검 — 세션 archive 시 캐시 보존)
  summary         TEXT NOT NULL,           -- 2-3 문장
  model_version   TEXT NOT NULL,           -- 'claude-haiku-4-5-...' (어느 모델로 만들어졌나)
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_count   INTEGER,                 -- 생성 시점의 메시지 수 (변하면 stale 신호)
  input_tokens    INTEGER,
  output_tokens   INTEGER
);

-- 24h TTL을 application 레이어에서 검사하므로 별도 인덱스 불필요.
-- (PRIMARY KEY가 session_id라 lookup은 항상 단일 row)
