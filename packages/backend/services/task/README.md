# services/task — 작업 / 자동화 / 스케줄링

Tower 의 **작업 (task)** 모듈. AI 가 백그라운드로 실행하는 단발/반복 작업, cron 스케줄, 자동화 워크플로 (Automation) 의 라이프사이클·실행·리포팅.

> 주의: "task" 는 AI 백그라운드 작업 (Claude/Pi 가 자율 실행). 사용자 간 채팅 (`room/`) 이나 사용자가 직접 대화하는 세션 (`session/`) 과 다름.

## 책임

- **작업 CRUD** — 생성, 조회, 업데이트, 삭제, 아카이브 (task-manager)
- **작업 실행 / 모니터링** — Claude/Pi 엔진 spawn, JSONL 폴링, 결과 채집·리포트 (task-runner)
- **단순 스케줄러** — 30초 주기로 due 작업 spawn (task-scheduler) — *legacy, unified-scheduler 가 흡수 중*
- **통합 스케줄러** — task + automation + proactive-agent 한 모델로 (unified-scheduler)
- **Automation / 스케줄 Job Registry** — cron / once / event 트리거 + workflow 템플릿 + 일반 job type (automation-manager)
- **Job runners** — `ai_prompt` / `webhook` / `shell` / `script` 실행 adapter (automation-runners)
- **Runtime Box schedule runner** — due job 시점에만 프로젝트 Runtime Box 를 wake 해서 command 실행 (runtime-box-schedule-runner)
- **Missed-run policy** — 지연된 cron 을 무한 catch-up 하지 않도록 결정 (missed-run-policy)
- **Legacy task migration planning** — `tasks.scheduled_at` / `tasks.schedule_cron` → `automations` dry-run plan (legacy-task-migration)
- **Legacy task migration script** — `scripts/migrate-legacy-tasks-to-automations.ts` 로 dry-run/apply 수행

## Public API

### `task-manager.ts` — 작업 CRUD
- `createTask` / `getTask` / `getTasks` / `updateTask` / `deleteTask`
- `getChildTasks(parentTaskId)` — 부모-자식 트리
- `getArchivedTasks` / `restoreTask` / `permanentlyDeleteTask` — 아카이브
- `reorderTasks` / `getDistinctCwds` — 정렬·필터 보조
- `backfillTaskProjects` — 부팅 시 1회, project_id 누락 row 보강
- `resolveProjectFromCwd(cwd)` — cwd 경로로 프로젝트 추정

타입: `TaskMeta`, `WorkflowMode`, `TaskReportPolicy`, `ScheduleCron`

### `task-runner.ts` — 작업 실행
- `spawnTask(taskId, opts)` — 메인 entry. 엔진 호출, JSONL 모니터, 완료 시 채널 푸시
- `abortTask(taskId)` — 중단 (SDK abortSession 호출)
- `resumeOrphanedTaskMonitoring(broadcastFn)` — 부팅 시 in-progress 작업 인계
- `stopAllMonitors` / `hasMonitoredTasks` / `isTaskRunning` / `getRunningTaskCount` — 라이프사이클·통계
- `MAX_CONCURRENT_TASKS` = 30 (시스템 한도)

### `task-scheduler.ts` — 단순 스케줄러 (deprecated 진행 중)
- `startScheduler` / `stopScheduler`
- `calculateNextRun(cron, from)` — cron 다음 실행 시점

> **참고**: unified-scheduler 가 같은 기능 + automation 까지 통합. task-scheduler 는 점진적으로 unified 로 이전 중. 새 기능은 unified 에 추가할 것.

### `unified-scheduler.ts` — 통합 스케줄러
- `startUnifiedScheduler` / `stopUnifiedScheduler` — 라이프사이클
- Schedule CRUD: `getSchedules` / `getSchedule` / `createSchedule` / `updateSchedule` / `deleteSchedule`
- 실행 이력: `getScheduleRuns(scheduleId)`
- `calculateNextRun(cron)` — 단일 진실 (task-scheduler 의 동명 함수와 다른 시그니처 — `CronConfig` 기반)

### `automation-manager.ts` — 스케줄 Job Registry
- Automation = 사용자-facing “스케줄” 탭의 job registry. 기존 AI task/schedule 을 흡수한다.
- `job_type`: `ai_prompt` / `webhook` / `shell` / `script` / `monitor`
- 트리거: manual / cron / once / event
- CRUD + run history + workflow template
- 핵심: `createAutomation` / `updateAutomation` / `advanceSchedule` / `logRun`

### `automation-mutation-policy.ts` — 공통 mutation 안전 경계
- REST/UI/Workbench/template 같은 진입점이 같은 생성 권한과 고위험 확인 정책을 사용하게 한다.
- 기존 row와 변경안을 합쳐 실제 실행될 `projectId` / `scopeType` / `jobType` / `definitionJson`을 다시 검사한다.
- 클라이언트가 보낸 `riskLevel`은 신뢰하지 않고 서버에서 항상 재계산한다.
- 핵심: `authorizeAutomationMutation`

### `schedule-permissions.ts` — 자동화 capability 경계
- `read` / `propose`: 프로젝트 멤버에게 허용한다.
- `run` / `edit` / `archive`: automation owner 또는 admin/operator에게만 허용한다.
- 프로젝트 membership은 가시성이지 운영 권한이 아니다. 명시적 delegated operator 모델이 생기기 전에는 owner 경계를 유지한다.
- 생성 시 shell/script는 project Runtime Box + fail-closed 정책을 별도로 검사한다.

### `automation-control.ts` — REST/Agent 공통 수동 제어
- `runAutomationNow()`가 runner 호출, `automation_runs`, runtime summary, Process Map event 기록을 한 경로로 묶는다.
- REST Run Now와 schedule MCP가 같은 감사 계약을 사용한다.
- enable/disable/archive helper도 capability 검사를 마친 caller가 재사용한다.

### `automation-change-intent.ts` — preview-first 설정 변경
- YAML 변경안을 base `config_updated_at`, materialized updates, risk, hash와 함께 30분 intent로 저장한다.
- 프로젝트 멤버는 `propose`할 수 있지만 apply는 owner/admin/operator의 `edit` capability가 필요하다.
- apply 시 proposal hash, expiry, base revision, 현재 권한과 risk를 다시 검사한다.
- intent는 `proposed → applying → applied|failed`로 한 번만 소비된다.

### `automation-runners.ts` — Job runner adapter
- `runAutomationJob(automation, broadcast?)` 가 job type 별 실행으로 dispatch 한다.
- `ai_prompt`: 기존 spawn/inject/channel 실행 의미 유지
- `webhook`: HTTP 호출 + status/body summary 저장
- `shell` / `script`: `definition_json.runner.preference` 가 `runtime_box` 이거나 Runtime Box 가 켜진 project job 이면 Runtime Box runner 를 우선 사용. Runtime Box 실패 시 기본 fallback 은 fail-closed.

### `runtime-box-schedule-runner.ts` — Runtime Box wake-and-run bridge
- Runtime Box 는 scheduler 가 아니다. Box 내부 crontab/systemd/node-cron 금지.
- Tower unified-scheduler 가 due job 을 관찰하고, 이 runner 는 실행 시점에만 `getOrCreateBox` + `execInBox` 를 호출한다.
- cwd 는 project-relative 로 저장하고 Runtime Box 안에서는 `/workspace` 기준으로 변환한다.
- v1 은 프로젝트별 shell/script schedule job 을 serial 실행하고, 전역 Runtime Box schedule 동시성 제한을 둔다.

### `missed-run-policy.ts` — missed-run 결정
- one-shot overdue 는 1회 실행 후 consumed.
- cron overdue 10분 이내는 catch-up 실행.
- cron overdue 10분 초과는 skipped run 기록 후 다음 시각 계산.
- interval 은 밀린 횟수만큼 몰아서 실행하지 않고 1회만 실행한다.

### `legacy-task-migration.ts` + migration script — legacy task schedule migration
- `planLegacyTaskScheduleMigration()` 은 기존 `tasks.scheduled_at` / `tasks.schedule_cron` rows 를 읽고 `automations` 변환안을 만든다.
- read-only dry-run API: `GET /api/automations/audit/legacy-task-migration` (admin/operator only).
- apply 는 `scripts/migrate-legacy-tasks-to-automations.ts --apply` 로 수행한다.
- apply 는 automation 생성 후 legacy task 의 `schedule_enabled = 0` 으로 중복 실행을 막는다.
- idempotency key 는 `definition_json.legacyTaskId` 이다.

## 들어오기 전에 알아야 할 것

- **task ≠ session**: task 는 백그라운드 자율 실행, 결과는 룸 메시지 또는 알림으로 도착. 세션은 사용자 인터랙티브 대화.
- **task-runner 의 in-process state**: `MAX_CONCURRENT_TASKS = 30`, 모니터 핸들 in-memory. 프로세스 재시작 시 `resumeOrphanedTaskMonitoring` 가 in-progress 작업 인계.
- **JSONL 폴링으로 완료 판별**: SDK 가 .jsonl 마지막 라인 쓰면 `checkJsonlForCompletion` 이 감지. 폴링 간격 짧음 (~1s).
- **여러 source of truth 공존 중**: legacy `tasks.scheduled_at`, legacy `schedules`, next-gen `automations` 가 아직 함께 있다. 새 스케줄 UI 는 `/api/automations` 를 사용한다. legacy `schedules` table tick 은 기본 off (`ENABLE_LEGACY_SCHEDULE_TICK=true` 일 때만 on), legacy `tasks.scheduled_at` tick 은 Task 탭 마이그레이션이 끝날 때까지 유지한다.
- **`calculateNextRun` 동명 함수 주의**: task-scheduler 와 unified-scheduler 에 둘 다 있지만 *다른 cron 형식*. 호출자가 어느 걸 import 하는지 확인 필수.
- **Automation 의 3 모드**: spawn 은 task 생성, inject 는 룸/사용자에게 메시지, channel 은 룸의 자동 응답. 헷갈리지 말 것.
- **task-runner 가 dynamic import 헤비**: 부팅 시간 단축 + 순환 의존 회피. 대부분의 외부 호출은 lazy.
- **report policy**: 작업 결과를 어디로 보낼지 (`channel` | `mention` | `silent`). task-manager 의 `reportPolicy` 컬럼.

## 관련 결정문서

- `workspace/decisions/2026-03-03-kanban-scheduled-tasks-design.md` — task 모델 초기 설계
- `workspace/decisions/2026-04-28-heartbeat-deprecation.md` — 감지는 lazy mtime, 실행은 Schedule/Task 로
- `workspace/decisions/2026-05-02-tower-scheduler-as-first-class.md` — unified-scheduler 도입
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/claude-sdk` — `executeQuery` / `abortSession` (task-runner 가 호출)
- `services/session/session-manager` — task 가 세션 생성·갱신
- `services/message-store` — 결과 메시지 저장
- `services/system-prompt` / `services/project-access` / `services/damage-control` — task 의 prompt + 가드
- `services/workflow-prompts` — workflow 템플릿 prompt builder
- `services/worktree-manager` — task 가 격리 worktree 에서 실행 (decision 2026-05-03)
- `services/proactive-agent` — unified-scheduler 가 proactive 발동 호출
- `services/room/room-manager` — task 결과를 룸에 메시지로 post
- `services/messaging/index` — 외부 채널 (Telegram, Kakao) 푸시
- `routes/api.ts` — task / schedule / automation REST 엔드포인트
- `routes/ws-handler.ts` — WS 로 task 진행 상황 broadcast

## 테스트

- 단위 테스트 없음 (PG + 엔진 의존성 큼). ws-handler.test.ts 가 task-runner / task-manager 를 vi.mock 으로 stub.
