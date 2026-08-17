-- 078_runtime_box_service_supervision.sql
-- Runtime Box service_start 를 실제 프로세스 supervision 으로 승격하기 위한 메타 컬럼.
--
-- v1 구현:
--   - docker exec 내부에서 nohup sh -lc <command> 로 장기 프로세스를 시작
--   - process_pid 는 컨테이너 내부 PID
--   - log_path 는 /workspace 기준 로그 파일 경로 (.runtime-box/logs/...)
--   - service_stop 은 process_pid 를 SIGTERM 후 SIGKILL fallback 으로 종료

ALTER TABLE runtime_box_services
  ADD COLUMN IF NOT EXISTS process_pid INT;

ALTER TABLE runtime_box_services
  ADD COLUMN IF NOT EXISTS log_path TEXT;

COMMENT ON COLUMN runtime_box_services.process_pid IS
  'Runtime Box 컨테이너 내부 장기 서비스 PID. service_stop 이 이 PID 를 종료한다.';

COMMENT ON COLUMN runtime_box_services.log_path IS
  'Runtime Box 컨테이너 내부 /workspace 기준 로그 파일 경로. 예: .runtime-box/logs/service-1-dev.log';
