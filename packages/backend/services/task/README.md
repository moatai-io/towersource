# services/task — 작업 / 자동화 / 스케줄링

Tower 의 **작업 (task)** 모듈. AI 가 백그라운드로 실행하는 단발 실행 Task, Automation Registry의 cron 스케줄, 자동화 워크플로 (Automation) 의 라이프사이클·실행·리포팅.

> 주의: "task" 는 AI 백그라운드 작업 (Claude/Pi 가 자율 실행). 사용자 간 채팅 (`room/`) 이나 사용자가 직접 대화하는 세션 (`session/`) 과 다름.

## 책임

- **작업 CRUD** — 생성, 조회, 업데이트, 삭제, 아카이브 (task-manager)
- **작업 실행 / 모니터링** — Claude/Pi 엔진 spawn, JSONL 폴링, 결과 채집·리포트 (task-runner)
- **cron 입력 검증** — `task-scheduler.ts`는 이름만 남은 `validateCron` 모듈이다. legacy Task 예약 실행은 퇴역했다.
- **통합 스케줄러** — task + automation + proactive-agent 한 모델로 (unified-scheduler)
- **Automation / 스케줄 Job Registry** — cron / once / event 트리거 + workflow 템플릿 + 일반 job type (automation-manager)
- **Job runners** — `ai_prompt` / `webhook` / `shell` / `script` 실행 adapter (automation-runners). `runAutomationObserveOnly()`는 AI를 생성하지 않을 뿐 명령·스크립트·웹훅을 실제 실행한다. 사용자 preview API가 아니다.
- **Runtime Box schedule runner** — due job 시점에만 프로젝트 Runtime Box 를 wake 해서 command 실행 (runtime-box-schedule-runner)
- **Missed-run policy** — 지연된 cron 을 무한 catch-up 하지 않도록 결정 (missed-run-policy)
- **Legacy task migration planning** — `tasks.scheduled_at` / `tasks.schedule_cron` → `automations` dry-run plan (legacy-task-migration)
- **Legacy task migration script** — `scripts/migrate-legacy-tasks-to-automations.ts` 로 dry-run/apply 수행

### 일반 사용자 Automation 생성·결과 조회 (A2~A4 로컬 구현)

- **정상 무처리 `none` (로컬, 미배포):** 확인은 성공했지만 처리 대상이 없으면 Run을 `none`으로 저장하고 결과 화면에는 “처리할 일 없음”으로 표시한다. AI Task는 명시적인 `[TASK NONE]`과 정상 Task 완료가 모두 있어야 이 결과로 투영한다. 실패·권한 오류·종결 marker 누락은 `none`으로 추측하지 않는다. Execution 자체는 정상 종료 `succeeded`를 유지하고 resultJson의 `automationOutcome`으로 Run 결과와 replay를 구분한다. 예약/수동 자동화의 none 알림과 Task none 알림은 생략하고 예약은 정상적으로 다음 회차로 진행한다. GitHub monitor도 신규 대상 0건을 none으로 기록한다. 과거 실패 이력은 자동 수정하지 않는다. 운영 실행과 제공자 응답은 미검증이다.

- **A3 완료 보고 연결 (로컬, 미배포):** Automation-owned spawn Task는 legacy runner와 Execution adapter 모두 `silent`이며 결과 보고는 Automation 소유 경로가 맡는다. 예약 완료/실패 알림 metadata에도 수동 실행과 같은 `automationId`·`runId`(가능한 경우 `executionId`)를 넣어 Run에 연결한다. terminal occurrence replay와 미완료 admission은 알림을 만들지 않는다. 회귀: `unified-scheduler-occurrence.test.ts`, `internal-channel-notification-migration.source.test.ts`, `adapters/legacy-task-execution-adapter.test.ts`, `automation-control.test.ts`. 이는 로컬 호출 횟수·소유권 검증이며 Notification 저장/푸시의 exactly-once 보장은 아니다. 운영 전달·읽음 연동은 미검증이다.

- **A3 개인 결과 확인 (로컬, 미배포):** migration `230_automation_result_receipts.sql`의 `(run_id,user_id)` 기록으로 읽음·조치 시각을 보존한다. `automation-result-receipts.ts`와 `POST /api/automations/results/:runId/receipt`는 인증된 사용자·현재 Automation 읽기 권한·Project 일치를 검사하고 중복 요청에서도 최초 기록을 보존한다. 조치 표시는 읽음도 포함하며 Run의 성공/실패나 알림 상태를 수정하지 않는다. 결과 탭은 개인 확인 버튼과 현재 목록의 미읽음 필터를 제공한다. 테이블/필수 컬럼이 없는 이전 서버는 기존 결과 조회를 유지하고 개인 상태 컨트롤을 숨긴다. 신규 알림은 생성하지 않는다. `WorkHub`의 `AutomationWorkResults`도 동일 API/receipt를 재사용한다. 사용자가 활성 Workspace를 선택해야 조회하며 이전 Workspace의 늦은 응답은 폐기한다. 상세는 기존 schedule 탭으로 이동하고 Session 링크는 서버가 ACL 검증한 경우에만 제공한다. 기존 Session unread 수와 Run receipt를 합산하지 않는다. 기존 Notification Hub 중복 정책의 종단 검증은 이 변경에서 완료하지 않았다. migration 작성만 했으며 운영 DB 적용/실행 검증은 하지 않았다. 테스트: `automation-result-receipts.test.ts`, `automation-results.test.ts`, `automation-results-api.http.test.ts`, `AutomationResultsPanel.receipts.test.tsx`.

- **A2 계획 검토 보강 (로컬, 미배포):** `automation-create-plan.ts`는 scheduler와 같은 zoned clock으로 cron의 다음 3회 실행 시각을 산출한다(일회성 1회, 수동 0회). `AutomationCreatePanel`은 선택한 IANA 시간대에 맞춰 표시한다. `automation-creation-readiness.ts`는 현재 계정의 Agent 실행 권한과 Workspace 디렉터리 접근, 기존 생성 정책과 모델 선택 가능 여부까지만 확인한다. 생성 시와 활성화 직전에 재검증하며 실패하면 활성화를 차단한다. UI도 필수 준비도 증거가 없으면 활성화 버튼을 막는다. 제공자 실제 인증·실행기 가용성·데이터 원천·도구별 쓰기 권한은 검증하지 않았다고 명시한다. 이는 실제 실행 성공의 보증이 아니다. 테스트: `automation-create-plan.test.ts`, `automation-creation-readiness.test.ts`, `AutomationCreatePanel.test.tsx`.

- **로컬 검증 갱신 (2026-09-28):** Execution·Process Map·Task·자동화 HTTP·Schedule UI 통합 회귀는 59개 파일/358개 테스트가 통과했다. opt-in PostgreSQL E2E 1개 파일/7개 테스트는 이번 실행에서 제외됐으며, 이를 운영 DB 검증으로 해석하지 않는다. backend/frontend 타입 검사·테마 계약·Vite 프로덕션 빌드와 `git diff --check`도 통과했다. 운영 배포·실제 예약 AI·외부 발송 검증은 수행하지 않았다.
- **요일/시각 경계:** 주간 자연어 요청이 여러 요일을 포함하면 지원하는 단일 요일로 임의 축소하지 않고 시각 재확인을 요구한다. 단일 요일 한국어/영어 요청은 유지한다. 일회성 draft는 검토 중 예정 시각이 지나면 활성화를 거부한다. 회귀 근거는 `automation-create-plan.test.ts`이다.

- `automation-create-plan.ts`와 `routes/automation-create-api.ts`: `POST /api/automations/creation-plans`는 검증된 단일 `ai_prompt + spawn` 계획을 **비활성 draft Automation**으로 저장한다. 모호한 시각은 질문으로 되돌리고, 명시한 시각과 선택값이 충돌하거나 조건부 실행·이메일 발송·DAG를 요구하면 활성화를 제공하지 않는다. 일반 멤버는 접근 가능한 활성 Project로만 만든다. 모델은 Core 프리셋 기본 또는 접근 가능한 동일 Project Pi Session의 저장된 선택만 이어간다. 계획은 실효 정의의 SHA-256·15분 만료·Project/모델/권한 재검사를 함께 제공하며 `POST /api/automations/creation-plans/:id/activate`는 생성자 확인 후 행 잠금과 해시 비교로 같은 ID를 켠다. 검토 중인 draft는 예약과 Run Now, 일반 enabled 경로에서 실행되지 않는다. 기존 MCP·legacy 자동화는 자동 이관하거나 변경하지 않는다. 검토 중 생성 draft는 저장되며 만료 시 자동 삭제하지 않는다.
- `automation-results.ts`와 `routes/automation-results-api.ts`: `GET /api/automations/results?projectId=...&limit=...`는 프로젝트 범위에서 Run 원장을 읽는다. 원장 상태와 Execution 상태를 분리하고 legacy AI spawn의 dispatch 성공을 완료로 표현하지 않는다. Session ID가 없는 결과도 목록에 남기며, 비공개 Session 관련 비정형 Run 증거와 링크는 Session ACL 재확인 후에만 보여 준다. `SchedulePanel`의 홈·결과·상세/이력 동선이 이 read model을 사용한다. 결과 목록은 Run 이력과 별도 개인 receipt를 나란히 표시하며, unread 필터는 현재 읽힌 목록에 한정되고 Work inbox나 Notification Hub unread와 연동하지 않는다. 기존 인앱 알림, Project mute 및 이메일 정책은 그대로 둔다. WorkHub에는 Workspace 선택 기반 Run 결과 패널을 연결했고, Notification Hub unread와의 연동·기존 알림 중복 정책의 종단 검증은 남아 있다.
- 코드/테스트 링크: `automation-create-plan.test.ts`, `automation-results.test.ts`, `routes/automation-create-api.http.test.ts`, `routes/automation-results-api.http.test.ts`, `SchedulePanel.results.test.tsx`. 현재 격리 HTTP/가짜 DB 테스트와 타입 검증은 실제 AI·Session 완료, 운영 migration/flag 및 배포를 증명하지 않는다.

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
- `spawnTask(taskId, opts)` — 메인 entry. 엔진 호출, JSONL 모니터, 완료 시 Notification Hub를 통한 보고
- `abortTask(taskId)` — 중단 (SDK abortSession 호출)
- `resumeOrphanedTaskMonitoring(broadcastFn)` — 부팅 시 in-progress 작업 인계
- `stopAllMonitors` / `hasMonitoredTasks` / `isTaskRunning` / `getRunningTaskCount` — 라이프사이클·통계
- `MAX_CONCURRENT_TASKS` = 30 (시스템 한도)

### `task-scheduler.ts` — cron 입력 검증 호환 이름
- `validateCron(cron)` — interval 범위를 검사한다.
- `MIN_INTERVAL_MINUTES` / `MAX_INTERVAL_MINUTES` — 1분부터 1주까지다.
- `startScheduler` / `stopScheduler` / `calculateNextRun`은 이 모듈의 현재 API가 아니다. 과거 Task 예약 필드는 신규 API에서 거부한다.

### `unified-scheduler.ts` — 통합 스케줄러
- `startUnifiedScheduler` / `stopUnifiedScheduler` — 라이프사이클
- `startUnifiedScheduler` / `stopUnifiedScheduler` — Automation Registry tick 라이프사이클
- 옛 `schedules` 테이블 CRUD·manual run·executor는 제거되었고 migration history만 남는다.
- 다음 실행 계산은 `automation-manager.ts`의 timezone-aware `calculateNextRun`이 소유한다.

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
- apply 시 proposal hash, expiry, base revision, 현재 권한과 risk를 다시 검사한다. 이전에 생성된 intent라도 현재 YAML validator와 실효 materialize 결과가 일치하지 않으면 적용하지 않는다.
- intent는 `proposed → applying → applied|failed`로 한 번만 소비된다.

### `automation-runners.ts` — Job runner adapter
- `runAutomationJob(automation, broadcast?)` 가 job type 별 실행으로 dispatch 한다.
- `ai_prompt`: spawn은 Task 종료 상태를 확인하고, inject는 대상 Session을 사용한다. legacy channel은 새 Session으로 실행하며 내부 chat_rooms에 쓰지 않는다.
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
- 신규 Execution 경로에서는 skip 전에 같은 dueAt 원장을 조회한다. 기존 Execution이 있으면 replay/non-terminal 검사로 이어지며, 조회 실패 시 dueAt을 보존한다. 원장이 없는 경우와 legacy 경로만 기존 skip 정책을 적용한다.
- interval 은 밀린 횟수만큼 몰아서 실행하지 않고 1회만 실행한다.

### `legacy-task-migration.ts` + migration script — legacy task schedule migration
- `planLegacyTaskScheduleMigration()` 은 기존 `tasks.scheduled_at` / `tasks.schedule_cron` rows 를 읽고 `automations` 변환안을 만든다.
- read-only dry-run API: `GET /api/automations/audit/legacy-task-migration` (admin/operator only).
- apply 는 `scripts/migrate-legacy-tasks-to-automations.ts --apply` 로 수행한다.
- apply 는 automation 생성 후 legacy task 의 `schedule_enabled = 0` 으로 중복 실행을 막는다.
- idempotency key 는 `definition_json.legacyTaskId` 이다.

## 들어오기 전에 알아야 할 것

- **task ≠ session**: task 는 백그라운드 자율 실행, 결과는 실행 Session 및 Notification 경로에서 확인. 세션은 사용자 인터랙티브 대화.
- **task-runner 의 in-process state**: `MAX_CONCURRENT_TASKS = 30`, 모니터 핸들 in-memory. 프로세스 재시작 시 `resumeOrphanedTaskMonitoring` 가 in-progress 작업 인계.
- **엔진별 복구 경로 구분**: Claude orphan 복구에는 `checkJsonlForCompletion`과 JSONL 모니터링이 남아 있다. Pi의 terminal 기반 복구와 모든 정상 실행 완료를 JSONL 폴링 하나로 설명하지 않는다.
- **예약 정본과 호환 분리**: 새 예약과 실행은 `automations`를 사용한다. legacy Task 및 옛 `schedules` 실행기는 퇴역했고 API도 과거 Task schedule 필드를 거부한다. `/api/schedules`는 Automation Registry adapter이며 migration 파일의 존재는 현재 runtime 의존을 뜻하지 않는다.
- **호환 파일명 주의**: task-scheduler라는 이름만 보고 실행 tick이나 예약 생성 경로로 사용하지 않는다.
- **Automation AI 모드**: spawn은 Task 실행, inject는 기존 Session 대상, channel은 새 Session을 만드는 legacy 호환 분기다. 내부 채널 응답 기능으로 설명하지 않는다.
- **task-runner 가 dynamic import 헤비**: 부팅 시간 단축 + 순환 의존 회피. 대부분의 외부 호출은 lazy.
- **report policy**: 신규/수정 값은 `notification` 또는 `silent`다. 과거 channel 계열 값은 호환 severity 해석이며 내부 채널 쓰기를 복원하지 않는다.
- **dry-run 호환 API 중단**: `/api/automations/:id/full-dry-run`과 `/observe-dry-run`은 저장된 shell/script/webhook을 실제 실행할 수 있어 410 Gone을 반환한다. Workbench에서 두 호출 버튼을 제거했다. 조건 계산 전용 `/condition-dry-run`은 제공된 stdout만 평가하며 실제 예약 조건부 AI를 구현한 것이 아니다. 실제 자동화 실행은 owner/run 권한이 필요한 `/run-now`를 사용한다. 무부작용 계획 확인 API는 별도 구현 전까지 제공하지 않는다.
- **YAML v1 범위**: `automationYamlDraft`는 단일 job과 time/manual trigger만 표현한다. `validateAutomationYamlV1`은 미실행 `condition/ai/report`, event trigger, 알 수 없는 키를 적용 오류로 반환한다. 기존 YAML 파일은 자동 삭제하지 않는다. 변경 intent는 기존 같은 종류 job의 `definitionJson`에 command/path/url만 병합하여 runner 정책을 보존하고 job type 전환은 전용 migration 검토가 필요하다. `/save-yaml`은 호환 파일 내보내기이며 DB 설정 적용이 아니다. 기존 파일은 `wx`로 덮어쓰지 않고 409를 반환하며 응답은 `configApplied: false`, `sourceOfTruth: false`로 명시한다. 새로 만든 파일의 history 저장에 실패하면 생성된 파일 경로를 500 응답에 반환하고 자동 삭제하지 않는다. Workbench의 혼동되는 파일 저장 버튼은 제거했다.
- **A0 범위 제한**: legacy 기존 정의는 읽기/실행 상태를 자동 변경하지 않는다. YAML v1이 표현하지 않는 mode/target 등 기존 필드는 `change-intents`에서도 별도의 preview가 필요하며 신규 일반 사용자에게 전면 편집 가능하다고 안내하지 않는다. `SchedulePanel`의 등록 목록은 실행 전 수동 자동화도 표시하되 '다가오는 실행'에는 enabled 상태와 `nextRunAt`이 있는 정의만 표시한다. 자동 제안 fallback은 기존 interval에서 명시적으로 요청한 유효한 간격만 수정하며, '10시 10분' 같은 시각을 '10분마다'로 바꾸거나 daily/once/manual을 간격 예약으로 전환하지 않는다. 시각 변경 요청은 현재 자동 편집 경로에서 LLM 호출 전 중단하고 별도 계획 검토가 필요함을 안내한다. 화면과 편집 대화의 예시는 기존 반복 간격 변경으로 제한한다. 무조건 오류만 내던 편집 폼은 제거하고 기존 대화 기반 변경 검토 동선으로 연결했다. 이 동선이 폼 입력을 이전한다는 뜻은 아니다.
- **검증 구분**: `automation-preview-retirement.http.test.ts`는 `api.ts`의 실제 handler를 추출해 격리 Express 앱에서 401/410 및 runner 미호출, `/save-yaml`의 새 파일 생성·충돌 409·미적용 응답을 확인한다. `automation-preview-auth.http.test.ts`는 실제 JWT·계정 상태 middleware와 같은 route handler를 격리 Express 앱에서 시험한다. `automation-a0-route-order.source.test.ts`는 `api.ts`의 A0 경로 고유성·인증·등록 순서와 선행 `/api` voice 마운트 및 `/` 하위 라우터의 경로 충돌 부재를 정적 확인하고, `automation-a0-editor-copy.source.test.ts`는 편집 대화의 미지원 기능 안내 및 LLM 호출 전 차단을 보호한다. 격리 HTTP 테스트에서는 미지원 요청이 LLM을 호출하지 않고 YAML을 변경하지 않음을 확인한다. 다만 이 정적·격리 경계도 전체 router의 동적 초기화·외부 mount·실 DB·운영 배포 확인을 대신하지 않는다.

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
- `services/notification-hub` — 실행 결과 보고. 과거 room 참조는 현재 내부 채널 쓰기의 증거가 아니다.
- `services/messaging/index` — 외부 채널 (Telegram, Kakao) 푸시
- `routes/api.ts` — task / schedule / automation REST 엔드포인트
- `routes/ws-handler.ts` — WS 로 task 진행 상황 broadcast

## 테스트

- [schedule-permissions.test.ts](schedule-permissions.test.ts): 조회·제안과 실행·변경 권한을 구분한다.
- [unified-scheduler-occurrence.test.ts](unified-scheduler-occurrence.test.ts): 격리 예약 tick에서 신규 Execution 오류 시 dueAt·one-shot을 보존하고, terminal replay는 추가 Run/Notification 없이 예약을 진행함을 확인한다. legacy 오류 진행은 유지한다. 별도 disposable PostgreSQL E2E는 병렬 admission·Run 연결·재조회를 확인하지만 운영 canary는 아니다.
- [automation-change-intent.test.ts](automation-change-intent.test.ts): preview intent와 재검증, 기존 runner 정책 보존과 구형 intent 적용 차단을 확인한다.
- [automation-yaml-schedule.test.ts](../../../shared/automation-yaml-schedule.test.ts): 지원 필드 round-trip 및 미실행 필드 검증 실패를 확인한다.
- [automation-preview-retirement.source.test.ts](../../routes/automation-preview-retirement.source.test.ts): 과거 dry-run API가 runner를 호출하지 않고 410을 반환하는 소스 경계를 확인한다. 격리 HTTP 테스트는 위 항목 참고. 전체 router/운영 검증은 별도다.
- [legacy-task-retirement.source.test.ts](legacy-task-retirement.source.test.ts): Task 예약 퇴역의 source 경계를 확인한다.
- [automation-ai-terminal.test.ts](automation-ai-terminal.test.ts): AI 결과와 terminal 상태를 확인한다.
- [internal-channel-dead-runtime-removal.source.test.ts](internal-channel-dead-runtime-removal.source.test.ts): 내부 Channel 퇴역을 확인한다.

후속 문서 검토는 위 예약 권한·legacy 예약·AI 모드에 한정한다. task-runner의 모든 복구·폴링·리포트와 실제 운영 tick은 새로 검증하지 않았다.

### AI 예약의 완료 대기 계약

- `spawnTask` 기본 호출은 백그라운드 실행을 시작하고 반환한다. UI/API 호출의 응답 시간을 유지한다.
- AI spawn 예약은 `waitForCompletion: true`를 명시해 실제 runner 종료와 terminal 상태 저장을 기다린 뒤 결과를 판정한다. `in_progress`를 종료 실패로 간주해서는 안 된다.
- `task-runner-authority.test.ts`는 지연된 엔진으로 대기/비대기 경계를 검증하고, `automation-ai-terminal.test.ts`는 예약의 옵션 전달과 중복 실행 차단을 검증한다.
- 프로세스 재시작을 가로지르는 Automation run 복구는 이 변경의 보장 범위가 아니다. 로컬 테스트와 실제 운영 배포 검증은 별개다.

### 예약 실행 서버와 중복 방지

- `scheduler-ownership.ts`는 deployment 판별상 production에서만 자동 예약 tick을 기본 활성화한다. 개발/기타 deployment는 `TOWER_SCHEDULER_ENABLED=true`를 명시해야 한다. 개발 테스트는 별도 DB에서 수행해야 하며, 이 override로 공유 운영 DB를 소비하지 않는다.
- `TOWER_SCHEDULER_ENABLED=false`는 어느 deployment에서든 자동 tick을 중지한다. 수동 실행 권한이나 이미 실행 중인 Task를 변경하지 않는다.
- Automation tick은 같은 DB의 PostgreSQL session advisory lock을 얻은 한 프로세스만 due 조회부터 실행·다음 시각 갱신까지 수행한다. 다른 프로세스는 tick을 건너뛴다. 잠금은 전용 pool connection에 유지하고 finally에서 해제한다.
- 이 잠금은 긴 AI 실행 동안 다른 자동 예약도 기다리게 하는 보수적 중복 방지다. per-job durable claim과 병렬 실행은 별도 설계 대상이다. 프로세스 강제 종료 직전 외부 효과의 exactly-once나 구버전 서버와의 상호 배제를 보장하지 않는다. legacy schedules와 수동 Run Now는 이 tick 잠금 범위 밖이다.
- 회귀 테스트: `scheduler-ownership.test.ts` (deployment 기본값, 동시 진입 차단, 오류 시 해제). 운영 배포 여부는 로컬 테스트와 별도로 검증한다.

### 기본 실행 모델

신규 Task의 모델 생략 기본값은 관리자 AI 설정의 Core(`defaults.session`) 매핑이다. 신규 Automation은 `preset/core` 선택 의도를 저장하고 실행 직전에 현재 VM의 Core 매핑을 검증·해석한다. 명시적으로 저장된 Task/Automation 모델과 기존 실행 기록은 소급 변경하지 않는다. 일반 대화의 Core 프리셋은 실행 시점에 VM-local 관리자 매핑을 해석하며, 이 변경은 설치 인스턴스 설정이나 배포를 수정하지 않는다. 관리자 화면은 Core 슬롯을 대화·업무 실행(자동화·백그라운드 포함), Lite 슬롯을 제목·짧은 요약 등 보조 실행으로 표시한다. `ai_task` 호환 필드는 Lite 슬롯이며 자동화 기본값이 아니다. 모델 미지정 proactive 실행과 Skill Workbench, 논리 `background` 정책도 Core를 사용한다. 압축 모델은 별도 경로이며 이 정책 변경에서 수정하지 않는다. 검증: `task-default-core.source.test.ts`, `model-policy/model-policy.test.ts`, `skill-workbench/skill-workbench.test.ts`, `AdminPanel.ai-operations.source.test.ts`.

## 대화와 자동화의 프롬프트 정합성

`task-runner.ts`는 제목과 요청 본문으로 `selectSystemPromptFragmentsForMessage`를 선택해 공유 system prompt와 Engine RunOpts 양쪽에 전달한다. Pi가 system prompt를 재구성할 때도 PDF·게시·산출물 등의 선택형 지침을 보존한다. 무인 실행의 앞머리 지침은 권한·차단 사유·검증에 한정하며, 일반 업무에 설계 검토·결정 문서·Git commit을 일률적으로 요구하지 않는다. 대화 이력 자체는 자동 상속하지 않으므로 필요한 대상과 조건은 자동화 본문에 명시해야 한다.

검증: `task-runner-authority.test.ts`의 request-selected guidance 회귀 테스트. 로컬 테스트 통과는 운영 VM 배포나 실동작 검증을 의미하지 않는다.

### 자동화 실행 환경 보강

- 새 자동화 생성 계획과 기본 생성 경로는 일반 업무용 `default` workflow를 사용한다. 기존에 명시적으로 저장된 `auto`/개발 workflow는 자동 변경하지 않는다.
- Task 실행자는 저장된 사용자 역할과 사용자명을 사용하며, Engine RunOpts에 사용자명·경로 제한·선택형 프롬프트 지침을 전달한다.
- Project 범위의 spawn 자동화는 legacy runner와 Execution Control Plane 양쪽에서 같은 `resolveAutomationAiCwd`를 사용해 현재 Project root를 기준으로 cwd를 검증한다. Project가 없거나 퇴역했거나 cwd가 범위를 벗어나면 다른 Workspace를 추측하지 않고 실패한다. system/legacy 실행 경로는 별도 호환 경계를 유지한다.
- 대화 이력·당시 모델 매핑·외부 서비스 상태의 동일성까지 보장하는 재현 snapshot은 아직 구현되지 않았다. 실행 환경 정합성과 업무 결과의 검증은 별개의 조건이다.

관련 검증: `automation-ai-terminal.test.ts`, `automation-create-plan.test.ts`, `task-runner-authority.test.ts`, `../workflow-prompts.test.ts`. 운영 이력·인프라 식별자는 공개 저장소에 기록하지 않는다.

### 기존 Session 주입 경로

`../ai/proactive-agent.ts`는 inject 실행에서 대상 Session의 cwd, Project, engine, engineSessionId, configDir를 사용한다. 현재 계정의 활성 상태와 `canSendSessionMessage` 접근 판정을 먼저 확인하며, 사용자 역할을 admin으로 고정하지 않는다. 명시한 Project와 대상 Session의 Project가 다르거나 경로·모델·엔진이 호환되지 않으면 메시지를 쓰거나 실행하기 전에 중단한다. 신규 proactive Session도 등록된 Project root를 사용한다.

검증: `../ai/proactive-agent.authority.test.ts`. 이 검증은 현재 사용자 권한과 실행 컨텍스트 전달에 대한 회귀 테스트이며, 실제 외부 서비스 호출·업무 산출물의 동일성을 보증하지 않는다.

### 최소 무인 실행 프롬프트 계약

`../workflow-prompts.ts`의 `buildUnattendedPrompt`는 workflow 인자를 받지 않는다. 실행기는 이 단일 계약을 직접 사용하며, `[WORKFLOW: …]` 응답으로 작업 모드를 변경하던 분류 처리도 제거했다. `auto/simple/default/feature/big_task`는 과거 저장 데이터 호환용 값으로만 남고 프롬프트 선택에 사용되지 않는다. 기존 값과 과거 실행 기록은 유지하되, 칸반 역할 선언·개발 중심 분류·필수 단계·가짜 Active Skills·하위 Task 생성용 curl 지시는 더 이상 주입하지 않는다. 실제 스킬과 프로젝트 지침이 업무 절차를 결정한다.

진행 단계 표식은 선택 사항이다. `[TASK COMPLETE]`, `[TASK NONE]`, `[TASK FAILED: reason]`는 기존 실행기의 완료 판정 호환성을 위해 유지하며, 완료 전 결과 검증을 요구한다. 승인·입력 부족은 현재 상태 모델에서 실패 사유로 보고한다. 별도 blocked 상태를 새로 도입하거나 외부 효과의 중복 방지를 시스템적으로 보장하는 변경은 아니다. 재개 시 이전 진행 기록을 성공 증거로 간주하거나 불확실한 외부 작업을 무조건 반복하지 않도록 명시한다.

검증: `../workflow-prompts.test.ts`의 모드 간 동일성·표식·재개 계약과 `task-runner-authority.test.ts`의 종료 판정 회귀 테스트. 칸반 UI/DB 제거, 기존 자동화 데이터 변경, 운영 배포는 이 변경의 범위가 아니다.
