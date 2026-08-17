-- ============================================================
-- 060: users 에 display_name, affiliation 컬럼 추가
-- ============================================================
-- 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
--
-- "가입 폼" 이 아니라 "admin/operator 가 멤버를 대신 만드는 폼" 에서 입력됨.
-- 기존 row 는 NULL — admin 패널에서 inline 편집으로 백필.

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliation TEXT;

COMMENT ON COLUMN users.display_name IS '사람이 부르는 이름 (예: 홍길동). NULL 허용 — 060 이전 row 는 비어있음. admin/operator 가 입력.';
COMMENT ON COLUMN users.affiliation  IS '소속(회사·팀·부서). 예: "ACME / 개발팀". NULL 허용.';
