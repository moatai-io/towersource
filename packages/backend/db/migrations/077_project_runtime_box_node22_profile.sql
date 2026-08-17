-- 077_project_runtime_box_node22_profile.sql
-- Project Runtime Box 기본 프로필을 node22 + python3.13 이미지명으로 정렬.
--
-- 배경:
--   075_project_runtime_boxes.sql 작성 시점에는 node20-python312가 placeholder 기본값이었다.
--   실제 v1 이미지는 tower-runtime-box:node22-python313 이므로 DB profile 기본값/제약도 함께 맞춘다.
--
-- Fresh install: 075가 old constraint를 만든 뒤 이 migration이 즉시 교체.
-- Existing install: 기존 row는 새 통합 profile로 이관.

ALTER TABLE project_runtime_boxes
  DROP CONSTRAINT IF EXISTS project_runtime_boxes_profile_chk;

UPDATE project_runtime_boxes
SET runtime_profile = CASE runtime_profile
  WHEN 'node20-python312' THEN 'node22-python313'
  WHEN 'python312' THEN 'python313'
  WHEN 'node20' THEN 'node22'
  ELSE runtime_profile
END
WHERE runtime_profile IN ('node20-python312', 'python312', 'node20');

ALTER TABLE project_runtime_boxes
  ALTER COLUMN runtime_profile SET DEFAULT 'node22-python313';

ALTER TABLE project_runtime_boxes
  ADD CONSTRAINT project_runtime_boxes_profile_chk CHECK (
    runtime_profile IN ('node22-python313', 'python313', 'node22', 'custom')
  );
