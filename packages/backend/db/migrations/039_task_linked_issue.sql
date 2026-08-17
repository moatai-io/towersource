-- D8 #5: Run as task — tasks.linked_issue_id
--
-- See decisions:
--   workspace/decisions/2026-04-25-ai-native-pm-d8-issue-as-execution-hub.md
--
-- "Open session"이 대화형 실행이라면 "Run as task"는 자율 실행. 같은 issue에
-- 대해 두 가지 실행 모드 모두 지원하기 위해 tasks 테이블에 linked_issue_id
-- 컬럼 추가 (단순 FK).
--
-- 한 issue가 여러 task를 trigger할 수 있고 (재시도, 분할 등), 한 task는
-- 정확히 한 issue에 link됨 → 1:N (single FK on tasks side).
--
-- Rollback:
--   ALTER TABLE tasks DROP COLUMN IF EXISTS linked_issue_id;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS linked_issue_id UUID
    REFERENCES knowledge_nodes(id)
    ON DELETE SET NULL;

-- "이 issue에 link된 tasks" 빠른 조회용 부분 인덱스
-- (issue 없이 만들어진 일반 tasks가 대부분이라 partial)
CREATE INDEX IF NOT EXISTS idx_tasks_linked_issue
  ON tasks (linked_issue_id, created_at DESC)
  WHERE linked_issue_id IS NOT NULL;
