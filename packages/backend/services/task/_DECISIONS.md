# task 모듈 — 구조 결정

## 왜 5 파일이 한 폴더에 묶였나

작업 *영속성* (task-manager), *실행* (task-runner), *스케줄링* (task-scheduler / unified-scheduler), *자동화* (automation-manager) — 다섯 다 "AI 백그라운드 작업 라이프사이클" 도메인. 묶으면 AI 가 "task 작업" 받았을 때 한 폴더에서 끝.

자동화 (automation-manager) 가 task 와 같은 폴더인 이유: automation 의 가장 흔한 모드 (spawn) 가 결국 task 를 생성. 둘이 같은 cron / schedule 모델 공유. 분리하면 호출자가 두 폴더 import.

## 왜 task 와 session 이 분리됐나

이름 비슷하지만 완전 다른 lifecycle:
- **session** = 사용자 인터랙티브 대화. 사용자가 시작·종료. 결과는 즉시 화면.
- **task** = AI 자율 백그라운드 작업. 사용자는 "해줘" 하고 떠남. 결과는 나중에 알림.

데이터 모델도 다름 (task 는 `scheduleCron`, `reportPolicy`, `parentTaskId` 등 task-specific). 합치면 SessionMeta 폭발.

## 왜 task-scheduler 와 unified-scheduler 가 공존하나 (deprecated 진행)

*과거*: task-scheduler 가 작업 cron 만 처리. 30초 polling.
*현재*: unified-scheduler 가 task + automation + proactive-agent 한 모델로 흡수 중.
*미래*: task-scheduler 제거 예정.

지금 둘 다 살려둔 이유: 기존 cron 데이터 마이그레이션 미완. unified 로 옮기면 일부 작업 누락 위험. 다만 2026-06-02 점검 기준 legacy `schedules` 테이블은 operator/demo-org/demo 모두 enabled row 가 없어 tick 을 기본 off 로 전환했다 (`ENABLE_LEGACY_SCHEDULE_TICK=true` 일 때만 on). legacy `tasks.scheduled_at` tick 은 실제 자체 호스팅 서버 에 사용 중인 row 가 있어 Task 탭 마이그레이션 완료 전까지 유지한다. Decision: `workspace/decisions/2026-05-02-tower-scheduler-as-first-class.md`.

`calculateNextRun` 이름 충돌은 의도적 — 둘 다 동일 의도, 다른 cron 형식. 마이그레이션 완료 후 task-scheduler 의 함수 제거.

## 왜 task-runner 가 42KB 한 파일인가 (분리 안 됨)

spawn / monitor / abort / report / hook 의 강결합 흐름:
- spawn 시 etablishes 모니터 핸들 → JSONL 폴링 → 완료 감지 → 결과 채집 → 채널 푸시 → DB 갱신 → notification
- 이 체인이 비동기 + 에러 핸들링 다중 분기. 분리하면 매개변수 전달 폭발.
- 외부에서 보면 인터페이스는 좁음 (`spawnTask`, `abortTask`, 라이프사이클 4개).

**deep module 의 정확한 정의** — 외부 표면적 작고, 내부는 응집된 큰 흐름.

## 왜 dynamic import 가 그렇게 많은가 (task-runner 안)

순환 의존 + 부팅 시간 둘 다. task-runner 가 import 하는 모듈들 (room-manager, ws-handler broadcast, project-access, pm-feed-context, room-context, messaging) 이 거꾸로 task-runner 를 알 필요 없음. dynamic 으로 끊으면:
- 부팅 시 task-runner 만 로드 (다른 무거운 의존성 lazy)
- 테스트 시 stub 쉬움
- 순환 위험 0

Node 가 import 한 번 후 캐시하므로 N 번째 호출 cost 무시.

## 왜 automation 의 3 모드 (spawn/inject/channel) 가 한 모듈인가

세 모드 모두 같은 trigger 모델 (manual/cron/once/event) + 같은 schedule 로직 + 같은 run history. 차이는 *실행할 액션* 만. 각 모드별 분기는 한 함수의 switch 로 충분. 분리하면 trigger / schedule / run history 코드가 3배 중복.

호출자 입장에서도 "automation 추가" 한 작업으로 끝. 모드 추가 (예: webhook) 시 한 파일 한 함수에 case 추가.

## 왜 `automations` 를 스케줄 Job Registry 로 확장하나

2026-06-02 스케줄 PRD 에서 Task 탭을 장기적으로 스케줄 탭에 흡수하기로 했다. 새 테이블을 바로 만들기보다 기존 `automations` 가 이미 tasks/schedules migration, `/api/automations`, `AutomationPanel`, `tickAutomations()` 를 갖고 있어 이를 v1 registry 로 승격한다.

일반화 경계는 “실행 관측 모델”까지다. 공통 필드 (`job_type`, `definition_json`, `risk_level`, run stdout/stderr/summary, runner_kind) 를 추가하되, 모든 자동화를 하나의 거대한 DSL 로 만들지는 않는다. 타입별 실행 차이는 `automation-runners.ts` adapter 가 책임진다.

Shell/script 는 Runtime Box runner 가 붙기 전까지 API 레벨에서 admin/operator-only 로 제한한다. 일반 사용자에게 host shell 을 열지 않는다.

## 왜 스케줄이 legacy Task 를 대체하나

2026-06-03 결정으로 스케줄 탭은 Task 의 보조 UI 가 아니라 기존 예약 태스크를 흡수하는 사용자-facing 작업 자동화 레이어가 되었다. `tasks.scheduled_at` / `tasks.schedule_cron` 은 자체 호스팅 서버 이관 완료 전까지 compatibility 로 유지하되, 새 생성은 `automations` 로 간다.

자체 호스팅 서버 migration 은 `scripts/migrate-legacy-tasks-to-automations.ts` 를 사용한다. dry-run 이 기본이고, apply 는 automation 을 먼저 만들고 legacy task 의 `schedule_enabled = 0` 으로 중복 실행을 막는다. idempotency key 는 `definition_json.legacyTaskId`. 관련 runbook: `docs/legacy-task-to-schedule-migration-runbook.md`.

## 왜 Runtime Box 안에 cron 을 두지 않나

Runtime Box 는 실행환경이지 scheduler 가 아니다. 수십 개 프로젝트 Box 가 각자 cron 을 감시하면 모두 idle-stop 되지 못하고, scheduler source of truth 도 흩어진다. 따라서 due job 관찰은 Tower 본체 `unified-scheduler` 하나가 맡고, Runtime Box 는 due 시점에만 wake 되어 command 를 실행하고 결과를 반환한다.

이 결정 때문에 shell/script job definition 은 host absolute path 가 아니라 project-relative path 를 저장한다. Runtime Box 실행 시에는 `/workspace` 기준으로 해석한다. Runtime Box 실패 시 host runner 로 자동 fallback 하지 않고 fail-closed 한다. system job 에 한해 명시적 `admin_host` fallback 을 나중에 검토할 수 있다.
