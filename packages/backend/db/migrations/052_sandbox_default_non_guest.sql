-- 052_sandbox_default_non_guest.sql — sandbox_enabled default = true (guest 제외)
--
-- 결정: workspace/decisions/2026-05-08-sandbox-default-on-non-guest.md
--
-- 배경:
--   043 마이그에서 users.sandbox_enabled 를 DEFAULT false 로 도입 (D6 보수적 시작).
--   그 후 D11 (본체 실행 절대 금지) + D12 (sandbox = 기본 호스팅 모델) 가 정해지면서
--   user-level default false 가 D12 정신과 모순. 신규 직원 합류 시마다 admin 이
--   SQL UPDATE 직접 쳐야 sandbox 사용 가능 — 운영 부담.
--
-- 적용 내용:
--   1) 컬럼 default false → true 로 전환 (신규 row 영향)
--   2) 기존 row backfill — admin/operator/member 만 활성, guest 는 그대로 false
--
-- guest 는 외부 손님/일회성 데모용 (5-role 모델, 2026-05-04). sandbox 노출 위험.

-- ── 1) 컬럼 default 전환 ───────────────────────────────────────────────
ALTER TABLE users ALTER COLUMN sandbox_enabled SET DEFAULT true;

COMMENT ON COLUMN users.sandbox_enabled IS
  '사용자 레벨 sandbox 토글 (4계층 토글의 3단계). default true (guest 제외). '
  'D12 (sandbox = 기본 호스팅) 정합으로 2026-05-08 false→true 전환. '
  '결정: workspace/decisions/2026-05-08-sandbox-default-on-non-guest.md';

-- ── 2) 기존 row backfill ──────────────────────────────────────────────
-- 멱등: 이미 true 인 row 는 건드리지 않음.
-- guest 는 그대로 false 유지.
UPDATE users
SET sandbox_enabled = true
WHERE sandbox_enabled = false
  AND role IN ('admin', 'operator', 'member');

-- ── 3) guest 강제 false 트리거 ─────────────────────────────────────────
-- createUser 로직 (services/auth/auth.ts) 은 INSERT 시 sandbox_enabled 를
-- 명시하지 않고 컬럼 default 에 의존함. (1) 에서 default 를 true 로 바꿨으므로
-- guest 신규 생성도 sandbox 활성으로 만들어짐 — 위험.
--
-- 코드 한 곳에서만 처리하면 향후 직접 INSERT 하는 다른 경로나, role 강등
-- (UPDATE users SET role='guest') 시점에도 활성으로 남음. DB 레벨 트리거가
-- 가장 견고.
--
-- 동작:
--   - INSERT 시 role='guest' 면 sandbox_enabled := false 로 강제.
--   - UPDATE 로 role 이 'guest' 로 변경되면 sandbox_enabled := false 로 강제.
--   - 그 외 (admin/operator/member) 는 건드리지 않음 — 명시적 토글 유지.
--
-- 결정: workspace/decisions/2026-05-08-sandbox-default-on-non-guest.md (선택지 A)

CREATE OR REPLACE FUNCTION users_guest_sandbox_force_off()
  RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'guest' THEN
    NEW.sandbox_enabled := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION users_guest_sandbox_force_off() IS
  'guest role 신규/변경 시 sandbox_enabled 를 false 로 강제. '
  '결정: workspace/decisions/2026-05-08-sandbox-default-on-non-guest.md';

DROP TRIGGER IF EXISTS trg_users_guest_sandbox ON users;

CREATE TRIGGER trg_users_guest_sandbox
  BEFORE INSERT OR UPDATE OF role ON users
  FOR EACH ROW
  EXECUTE FUNCTION users_guest_sandbox_force_off();
