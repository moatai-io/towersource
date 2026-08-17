-- D8: Issue를 '실행의 허브'로
--
-- See decisions:
--   workspace/decisions/2026-04-25-ai-native-pm-d8-issue-as-execution-hub.md
--
-- 두 가지 변경:
--   1. knowledge_nodes에 execution_status 컬럼 추가
--      = "지금 무엇이 일어나고 있나" (status와 별개, 자동 derive)
--   2. knowledge_node_sessions 테이블 신설 (M:N: issue ↔ session)
--      = "이 issue에서 어느 세션이 작업했나"
--
-- git_commits.issue_id 연결은 별도 commit (Phase 2-e)에서.
-- git_commits 테이블이 현재 0행이라 populate 작업이 선행되어야 의미 있음.
--
-- Rollback:
--   DROP TABLE IF EXISTS knowledge_node_sessions;
--   ALTER TABLE knowledge_nodes DROP COLUMN IF EXISTS execution_status;

-- ════════════════════════════════════════════════════════════════════
-- 1) execution_status — 사람 입력 X, 자동 derive
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS execution_status TEXT
    DEFAULT 'idle'
    CHECK (execution_status IN ('idle', 'working', 'awaiting_review', 'done', 'archived'));

-- 기존 issue에 대해 status로부터 자동 derive
UPDATE knowledge_nodes
   SET execution_status = CASE status
     WHEN 'open'        THEN 'idle'
     WHEN 'in_progress' THEN 'working'
     WHEN 'done'        THEN 'done'
     WHEN 'archived'    THEN 'archived'
     ELSE 'idle'
   END
 WHERE kind = 'issue'
   AND execution_status = 'idle';  -- 새로 추가된 컬럼이므로 모두 default

-- "지금 작업 중인 것" 빠른 조회용 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_working
  ON knowledge_nodes (updated_at DESC)
  WHERE execution_status IN ('working', 'awaiting_review');


-- ════════════════════════════════════════════════════════════════════
-- 2) knowledge_node_sessions — issue ↔ session M:N link
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS knowledge_node_sessions (
  node_id    UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,         -- sessions.id (FK 안 걸음 — 세션 archive 시 link 보존)

  -- 'work'      — issue를 해결하기 위해 시작된 세션
  -- 'source'    — issue가 추출된 출처 세션 (provenance와 별개로 명시)
  -- 'reference' — 관련 토론이 있었던 세션
  link_type  TEXT NOT NULL DEFAULT 'work'
              CHECK (link_type IN ('work', 'source', 'reference')),

  linked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,

  PRIMARY KEY (node_id, session_id, link_type)
);

-- "이 issue를 작업한 세션들" 조회 (issue detail page)
-- (PRIMARY KEY가 (node_id, ...)라 자동 인덱스됨)

-- "이 세션에서 작업한 issue들" 조회 (세션 사이드바 등)
CREATE INDEX IF NOT EXISTS idx_knowledge_node_sessions_by_session
  ON knowledge_node_sessions (session_id, link_type);
