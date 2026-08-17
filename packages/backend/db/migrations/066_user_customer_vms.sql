-- 066_user_customer_vms.sql — customer-manager 역할용 담당 VM 매핑 테이블
--
-- 결정: workspace/decisions/2026-05-23-customer-manager-role.md
--
-- customer_manager 역할을 가진 사용자가 "어떤 자체 호스팅 서버을 관리하는가"를 명시.
-- /fleet, /customer-voice 등의 스킬이 이 테이블을 참조해 "내 담당 VM만" 필터링.

CREATE TABLE IF NOT EXISTS user_customer_vms (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id   TEXT    NOT NULL REFERENCES gateway_customers(id) ON DELETE CASCADE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, customer_id)
);

COMMENT ON TABLE user_customer_vms IS
  'customer_manager 역할 사용자의 담당 자체 호스팅 서버 매핑. fleet/customer-voice 등이 참조.';
