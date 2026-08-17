-- 047_role_guest.sql — 5-Role 모델 (guest 신설) DB 정합성
--
-- 결정: workspace/decisions/2026-05-04-five-role-model.md
--
-- users.role 컬럼은 CHECK 제약이 없는 free TEXT 라 enum 변경은 코드 측에서만
-- 처리되지만 (damage-control.VALID_ROLES), 이 마이그레이션은 다음을 보장한다:
--
--   1. 045_auto_member_seed 가 viewer 만 제외하고 backfill 했으므로,
--      guest 라는 role 값이 *기존 DB 에 등장한 적이 없음* — 정합성 OK.
--   2. 만에 하나 외부에서 'guest' 가 들어와 있더라도, 045 의 의도대로
--      guest 도 auto-seed 에서 제외되도록 *한 번* 정리한다 (멱등).
--   3. 향후 신규 흐름은 group-manager.autoSeedProjectMembers /
--      autoSeedUserMemberships 가 코드 레벨에서 guest 를 제외한다.
--
-- 즉 이 SQL 자체는 거의 noop 가깝지만, 결정 문서와 마이그레이션 인덱스를
-- 일치시키기 위해 둔다 (audit trail).

-- (안전망) guest 사용자가 이미 project_members 에 들어가 있다면 — 045 이전에
-- 수동으로 만든 guest 등 — 그 row 들이 'member' 로 시드되어 있을 수 있다.
-- 정책상 guest 는 명시 invite 만 받아야 하므로, 'member' 자동시드 row 만 제거.
-- owner / 명시적 'member' 가 아닌 'member' (autoSeed 기원) 를 구분할 방법이
-- 없으므로 보수적으로 — 'guest' role 사용자에 한해 'member' 로 시드된 것만 정리.
--
-- 단 045 가 viewer 만 거르고 guest 도 'member' 로 넣었을 가능성이 있는 시점
-- (이 마이그레이션 직전) 에 이미 guest 가 있는 환경이라면 다음 한 줄이 청소.
DELETE FROM project_members pm
USING users u
WHERE pm.user_id = u.id
  AND u.role = 'guest'
  AND pm.role = 'member'
  AND NOT EXISTS (
    -- owner 행은 이미 별도 — 그 자체는 보존
    SELECT 1 FROM project_members pm2
    WHERE pm2.project_id = pm.project_id AND pm2.user_id = pm.user_id AND pm2.role = 'owner'
  );

-- 멱등 — 'guest' 사용자가 없으면 0 row 영향. 마이그레이션 runner 가 한 번 실행한 뒤
-- 이후 모든 자동 시드는 group-manager 코드가 guest 를 거른다.
