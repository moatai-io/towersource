-- 045_auto_member_seed.sql — Member auto-seed backfill
--
-- 결정: workspace/decisions/2026-05-02-member-auto-membership.md
--
-- 정책: 모든 active non-viewer user 는 모든 active project 의 member 여야 한다.
-- 신규 흐름은 services/auth.createUser 와 services/project-manager.createProject
-- 가 처리. 이 마이그레이션은 그 이전에 만들어진 기존 (user, project) 페어에 대해
-- 한 번만 멤버십을 채워준다.
--
-- 멱등: ON CONFLICT DO NOTHING. owner 행은 role='owner' 로 이미 들어가 있으니
-- 'member' 새로 못 들어감 → 그대로 보존.

INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, u.id, 'member'
FROM projects p
CROSS JOIN users u
WHERE (p.archived IS NULL OR p.archived = 0)
  AND u.disabled = 0
  AND u.role != 'viewer'
ON CONFLICT DO NOTHING;
