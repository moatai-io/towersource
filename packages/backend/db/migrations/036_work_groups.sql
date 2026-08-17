-- D7: knowledge_work_groups (과제) + 조인 테이블
--
-- See decisions:
--   workspace/decisions/2026-04-25-ai-native-pm-d7-four-layer-work-model.md
--
-- 4-layer work model의 L1을 추가:
--   L0 프로젝트 (projects)         — 권한·접근 단위 (기존)
--   L1 과제 (knowledge_work_groups) — 일거리의 한 갈래 (신규)
--   L2 이슈 (knowledge_nodes)      — 추적 단위 (기존)
--   L3 할 일 (TodoWrite 등)        — 실행 단위 (세션 내)
--
-- M:N 멤버십 채택 (단일 FK 아님): 한 issue가 여러 과제에 동시 속할 수 있음.
-- 산업 전례 (Linear/Jira/Asana/Notion/GitHub) + 자체 cross-cutting 검증 결과.
--
-- 4 규약 (D7에서 결정):
--   1. 멤버십 선택적 — 0개 OK (unassigned 빈 허용)
--   2. is_primary 플래그 — 카드 기본 표시 그룹
--   3. Status는 issue 자체 속성 (그룹별 분열 X)
--   4. 과제 archive 시 link만 끊기 (issue 보존)
--
-- Rollback:
--   DROP TABLE IF EXISTS knowledge_node_work_groups;
--   DROP TABLE IF EXISTS knowledge_work_groups;
--   (knowledge_nodes 자체는 영향 없음 — FK가 없으므로)

-- ════════════════════════════════════════════════════════════════════
-- knowledge_work_groups — L1 과제
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS knowledge_work_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- L0 프로젝트로 묶임 (선택적). NULL = 프로젝트 없는 personal/cross-project 과제.
  -- ON DELETE: project이 사라져도 과제는 살림 (data preservation).
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,

  name          TEXT NOT NULL,
  description   TEXT,

  -- 'active' (현재 작업 중) | 'archived' (보존하지만 보드에서 숨김)
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),

  -- 과제 lead — 전체 책임. issue assignee와 다름 (issue assignee = 단일 이슈 책임).
  lead_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- 'ai' (Tier 1 capture가 만듦) 또는 user_id (수동 생성)
  created_by    TEXT NOT NULL DEFAULT 'ai',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active 과제 빠르게 조회 (skill에 inject할 때, board sidebar 등)
CREATE INDEX IF NOT EXISTS idx_knowledge_work_groups_active
  ON knowledge_work_groups (project_id, updated_at DESC)
  WHERE status = 'active';

-- Name 검색 (case-insensitive exact match — Tier 1 attachment 시)
CREATE INDEX IF NOT EXISTS idx_knowledge_work_groups_name_lower
  ON knowledge_work_groups (LOWER(name))
  WHERE status = 'active';

-- Updated_at 자동 갱신 (knowledge_nodes 패턴 재사용)
CREATE OR REPLACE FUNCTION knowledge_work_groups_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_work_groups_touch ON knowledge_work_groups;
CREATE TRIGGER trg_knowledge_work_groups_touch
  BEFORE UPDATE ON knowledge_work_groups
  FOR EACH ROW EXECUTE FUNCTION knowledge_work_groups_touch_updated_at();


-- ════════════════════════════════════════════════════════════════════
-- knowledge_node_work_groups — M:N 조인 테이블
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS knowledge_node_work_groups (
  node_id       UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  work_group_id UUID NOT NULL REFERENCES knowledge_work_groups(id) ON DELETE CASCADE,

  -- 카드 기본 표시 그룹 결정. 한 issue당 최대 1개 primary (부분 unique 인덱스로 강제).
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,

  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,

  PRIMARY KEY (node_id, work_group_id)
);

-- 한 issue는 동시에 두 개 이상의 primary를 가질 수 없음.
-- 부분 unique 인덱스: is_primary=TRUE인 row 사이에서만 (node_id) 유일.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_node_one_primary
  ON knowledge_node_work_groups (node_id)
  WHERE is_primary = TRUE;

-- "이 과제에 속한 issue들" 빠른 조회 (Board view 그룹핑)
CREATE INDEX IF NOT EXISTS idx_knowledge_node_work_groups_by_group
  ON knowledge_node_work_groups (work_group_id, added_at DESC);

-- "이 issue가 속한 과제들" 조회 (issue detail 페이지)
-- (PRIMARY KEY가 (node_id, work_group_id)라서 자동으로 node_id 인덱스가 됨)
