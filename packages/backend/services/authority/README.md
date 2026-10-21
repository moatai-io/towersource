# Authority services

역할 문자열만으로 업무 권한을 확대하지 않도록, 리소스 사실을 받아 판정하는 정책과 현재 Agent 실행 입구를 제공한다. 전체 정본은 [권한과 파일 저장 경계](../../../../docs/architecture/authority-and-storage.md)다.

## Public API와 책임

| 파일 / 함수 | 책임 |
|---|---|
| `authorization-policy.ts` / `authorizeTowerAction()` | role × resource × action과 ownership/membership/scope 사실을 받아 순수 판정한다. 별도 ACL DB가 아니다. |
| `agent-execution-access.ts` / `requireCurrentAgentExecutionAccess()` | 현재 계정·역할·Project/Agent 상태·writable membership을 DB에서 재확인한다. Session snapshot을 실행 권한으로 신뢰하지 않는다. |
| `agent-execution-policy.ts` / `resolveProjectAgentExecutionIdentity()` | Agent Project principal과 requester user/Session을 구분한다. 호출자가 먼저 현재 접근을 검증해야 한다. OS 격리 증명은 아니다. |
| `execution-gate.ts` / `evaluateExecutionGate()`, `isHighImpactExecutionAction()` | 사람의 입구 권한과 Agent policy를 분리하고 `allow`, `deny`, `needs_setup`, `needs_confirmation` 및 capability/audit metadata를 반환한다. |
| `agent-authority-policy-update.ts` / `preserveAgentExecutionAuthority()`, `assertOrdinaryAgentCreationAuthority()` | 일반 staffing/profile 변경에서 reserved `superuser` 실행 권한을 새로 부여하거나 변경하지 못하게 한다. |
| `user-management-policy.ts` / `canManageUserRole()` | operator가 일반 계정을 관리하되 동급 operator/admin의 역할을 변경하거나 승격하지 못하게 한다. |

## 현행 계약

- 사람은 Agent 사용 입구에서 판정하고 Agent는 자기 실행 정책·연결 범위로 일한다. admin/operator가 일반 Agent를 사용해도 그 역할만으로 host·cross-project·deploy capability를 추가하지 않는다.
- admin/operator의 운영 권한은 콘텐츠 권한이 아니다. 일반 에이전트는 명시적 초대, private 대화는 소유권을 요구한다. `pm/project-access.ts`의 audience, send, content, metadata helper를 구분한다.
- member의 일반 실행·변경은 writable Project 사실에 의존한다. viewer/guest는 실행·변경하지 못한다. 공유 Session read는 send/mutation으로 확대하지 않는다.
- Credential은 scope별로 판정한다. 현재 순수 정책은 operator의 Project/workspace 관리·reveal 및 writable Project member의 Project 관리·reveal을 허용한다. 실제 값 열람에는 Vault consumer와 Runtime `secretValueVisibility`·감사 등의 제한도 적용된다. 과거의 일괄 admin-only reveal 설명을 사용하지 않는다.
- **Operator access 예외:** admin/operator는 전용 Agent 설정 경로로 `superuser`를 켜거나 끌 수 있다. 활성/ready Agent에서 현재 역할·설정을 재확인한 Pi host bash는 Backend OS 사용자로 실행한다. OS root를 의미하지 않으며 별도 서버 allowlist/추가 사용 승인은 없다. 위험 작업별 확인은 유지한다. member나 일반 Agent의 자동 host fallback은 없다.

`authorization-policy.ts`의 순수 판정만 호출했다고 모든 실제 경계가 강제되는 것은 아니다. caller가 리소스 사실과 좁혀진 capability를 전달하고 route/provider가 소비한다. 특히 `execution-gate-shadow.ts`는 대부분 관찰하며 일부 직접 서비스 수명주기 명령만 hard-stop한다. `execution-gate-integration.md`는 과거 통합 계획이며 현재 enforcement나 reveal 정책 정본이 아니다.

## 코드와 테스트를 읽는 순서

1. 위 순수 정책·현재 실행 입구와 인접 단위 테스트를 읽는다.
2. [project-access.ts](../pm/project-access.ts)와 [테스트](../pm/project-access.test.ts)에서 Session audience 및 현재 파일 쓰기 ACL을 확인한다.
3. [Pi tool assembly](../../engines/pi/tool-assembly.ts)의 `resolveOperatorHostAccess()`와 host command 직전 재검사를 확인한다. [storage characterization](../../engines/pi/tool-assembly.storage-characterization.test.ts)은 host/Worker bytes 불일치와 host 입구 거부·회수의 행동 테스트다. 원하는 저장소 일관성이 완료됐다는 증거가 아니다.
4. `acceptance/`는 계층 간 회귀 계약이다.
   - `control-plane-authority.acceptance.test.ts`: 순수 역할 매트릭스와 Session/Credential consumer source wiring을 검사한다. 전체 HTTP 종단 검증은 아니다.
   - `workbench-authority.acceptance.test.ts`: mock provider로 `worker:execute`와 거부 시 reservation 해제를 검사한다. role 없는 내부 호환 호출도 명시적으로 남아 있다.
   - `remote-worker-boundary.acceptance.test.ts`: localhost Worker에서 signed receipt 범위/replay와 합성 file Credential redaction·정상/timeout cleanup을 검사한다.

저장소 루트에서 `npm run test:authority`, `npm run test:authority:worker`, 또는 `npm run test:authority:all`로 실행한다. 운영 Vault·Worker에 의존하지 않으며 실제 배포·서로 다른 OS 계정의 격리를 증명하지 않는다.

## 문서 상태

2026-09-13 갱신. Agent 실행주체 정책 및 후속 Operator access 예외를 현행 코드와 대조했다. 파일 저장 경계의 첨부 분리는 미커밋 소스 관찰이며, 이번 문서 정비는 권한 코드 변경·마이그레이션·운영 검증이 아니다.

- Operator access 프로젝트 파일 예외: 현재 operator 계정·writable 초대와 활성 Project의 설정을 재확인해 파일 API와 Pi 파일 도구에서 코드 수정도 허용한다. `pm/project-access.ts:isOperatorAccessProjectPath`와 `pm/operator-access-files.test.ts`가 경계와 회수 검증을 소유한다. 배포 승인을 포함하지 않는다.

## 초대제·private 실행 경계

일반 대화는 에이전트 구성원에게 기본 공유되며 private는 소유자만 접근한다. private는 대화 접근만 제한한다. 파일 쓰기·수정·shell·산출물은 기존 권한 아래 허용하며 에이전트 파일은 구성원에게 공유된다. 실제 host/DB 관리자와 같은 OS 계정의 완전 격리는 보장하지 않는다. 관리자 self-join과 전역 목록·검색 예외는 제거되었으며 명시적 운영 host-admin action은 콘텐츠 권한과 분리한다. 기존 데이터 전환과 배포는 실행하지 않는다.

## Retired organization admission and current team path

The unactivated organization-wide user allowlist was superseded by explicit
team membership. Project execution no longer reads its `app_settings` entries.
Organization scope is rejected even for administrators or stale grant flags.
The old internal setter is a no-I/O rejection tombstone; no operational rows
were deleted or migrated. Current team facts remain in `agent-workspaces`.

Team execution is still blocked until actual executor enforcement is ready;
this change does not activate team execution or change Session audience.
Validated locally: 7 suites / 101 tests, including isolated PostgreSQL, passed.
Historical organization-admission tests are not evidence of current support.
