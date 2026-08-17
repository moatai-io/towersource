-- 063_session_file_edits_unique.sql
-- (session_id, file_path) UNIQUE 추가 + 기존 중복 DEDUPE.
--
-- 배경: 2026-05-20 PG 단일 소스 통합 (workspace/decisions/2026-05-20-session-file-edits-pg-unification.md).
-- Claude 엔진의 PostToolUse hook 도 이 테이블에 쓰기 시작 → 같은 (session, file) 행이
-- 여러 번 들어갈 수 있어 ON CONFLICT DO NOTHING 가드가 필요.
-- 백링크 조회는 어차피 DISTINCT 라 중복은 IDF 점수에 영향 없지만, 디스크/쿼리 비용
-- 절감 + 정합성 보장 위해 UNIQUE 강제.
--
-- (tool_name 은 키에서 제외 — 같은 파일을 Edit + Write 둘 다 한 경우도 "이 세션이
-- 이 파일을 만졌다" 한 사실로 충분. 첫 기록의 tool_name 유지.)

BEGIN;

-- 1. DEDUPE: 같은 (session_id, file_path) 가 여러 번 있으면 가장 오래된 id 만 남김
DELETE FROM session_file_edits sfe1
USING session_file_edits sfe2
WHERE sfe1.session_id = sfe2.session_id
  AND sfe1.file_path  = sfe2.file_path
  AND sfe1.id > sfe2.id;

-- 2. UNIQUE 인덱스 (CONCURRENTLY 는 트랜잭션 안에서 못 쓰니 일반 인덱스. 테이블이
--    작아 lock 영향 미미 — admin VM 기준 < 200 rows. self-hosted server 에서도 Pi 사용량
--    적어 잠금 시간 짧음.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_sfe_session_file
  ON session_file_edits (session_id, file_path);

COMMIT;
