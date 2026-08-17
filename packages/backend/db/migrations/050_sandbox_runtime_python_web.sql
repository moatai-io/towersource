-- 050_sandbox_runtime_python_web.sql — python-web variant 추가
--
-- 결정: workspace/decisions/2026-04-28-execution-sandbox-q4-package-scope.md
-- 빌드: 2026-05-05, tower-sandbox-python:3.12-web (3 execution VM)
--
-- sandbox_runs.runtime 과 internal_tools.runtime 의 CHECK constraint 에
-- 'python-web' 추가. 기존 데이터 영향 없음 (ENUM 확장).

ALTER TABLE sandbox_runs DROP CONSTRAINT IF EXISTS sandbox_runs_runtime_chk;
ALTER TABLE sandbox_runs ADD CONSTRAINT sandbox_runs_runtime_chk CHECK (
  runtime IN ('python', 'python-data', 'python-web', 'node', 'node-utils', 'bash')
);

ALTER TABLE internal_tools DROP CONSTRAINT IF EXISTS internal_tools_runtime_chk;
ALTER TABLE internal_tools ADD CONSTRAINT internal_tools_runtime_chk CHECK (
  runtime IN ('python', 'python-data', 'python-web', 'node', 'node-utils', 'bash')
);
