# Credential Vault

Tower의 VM 공유 Secret 저장소와 Agent Connection용 Credential metadata를 관리한다.

## 현재 모델

`workspace_credentials`는 두 scope만 지원한다.

- `workspace`: 이 Tower VM의 모든 일반 Agent가 자동으로 사용할 수 있는 팀 공용 Credential
- `project`: `project_id`가 가리키는 한 Agent만 사용할 수 있는 Agent 전용 Credential

Project별 allow/deny policy, Credential Profile, workspace default, target sync, personal scope는 Migration 192에서 제거되었다.

Runtime 접근 조건은 다음 하나다.

```sql
scope = 'workspace'
OR (scope = 'project' AND project_id = 현재 Agent Project)
```

개인 Credential을 자동 승격한 과거 migration의 `legacy_personal_owner_user_id`가 남은 record는 위 scope와 무관하게 실행·값 보기·가져오기·공용 승격에서 격리한다. 일반 rotation/upsert로 이 provenance를 지울 수 없다. Provider 계정과 동의 범위를 확인하고 새 ID로 명시적으로 다시 등록해야 하며, 이 서비스는 기존 개인 Secret을 자동 복제하지 않는다.

## Secret 저장 경계

`workspace_credentials`는 provider, kind, display name, env name, scope, `project_id` 같은 metadata만 저장한다. 평문 값은 `secret_store`에 저장하며 `secret_name`으로 연결한다.

목록과 상태 진단은 Secret을 반환하지 않는다. 값 열람은 프로젝트 전용 연결의 쓰기 member 또는 공용 연결의 operator/admin이 명시적으로 요청할 때만 허용하며 `credential_audit_events`에 기록한다. Restricted/deployed Agent는 실행 게이트와 도구 조립 단계에서 평문 열람을 차단한다.

런타임 조회는 `getSecretForProjectBinding(secret_name)`으로 등록된 global 값만 읽으며 요청자 개인 Secret이나 grant를 우선 선택하지 않는다. `userId`는 감사의 수행자 식별용이다. HTTP와 도구의 연결 변경·reveal·import는 최신 계정 상태와 실제 record scope에 대해 `assertCredentialManagementAccess()`를 거친다. trusted 모델 자체는 관리 권한이 아니다. 프로젝트 연결의 member 권한은 현재 `project_members.role`이 owner/admin/member인지로 판정한다. 생성자 이력(`projects.user_id`)은 viewer 강등이나 membership 삭제 후 권한을 복원하지 않는다. operator/admin의 회사 관리 권한은 별개다.

새 Credential은 서버가 `VAULT_...` 저장 이름을 만든다. 사용자 입력 env/name으로 플랫폼 또는 다른 Agent의 global Secret을 덮어쓸 수 없다. 여러 record가 같은 저장 이름을 참조하는 legacy 연결은 rotation 전 명시적인 이관이 필요하다.

## 선택적 기존 GWS 실행 호환 경로 (구현 후보, 미배포)

`legacy_gws_runtime_bindings`는 자동 생성되지 않는 운영자 승인용 호환 binding이다. 기존 `workspace`/`project` scope나 개인 Credential 격리 규칙을 대체하지 않는다. 실행 전 Agent 연결 접근을 통과한 Google `gws` record에만 적용한다.

- 정확한 기존 `secret_id`와 승인 당시 `allowed_user_ids`를 고정한다. 사용자 개인 계정을 자동 선택하지 않는다.
- 매 호출마다 고정 허용 목록과 현재 Secret grant/소유권, 활성 계정 및 실행 가능 역할의 교집합을 확인한다. 신규 사용자 추가는 자동 허용되지 않는다.
- binding이 존재하지만 비활성화·권한 회수 상태이면 global 또는 개인 값으로 fallback하지 않는다.
- reveal/import/API-key 경로에는 이 예외를 적용하지 않는다. 감사 저장 실패 시 값을 반환하지 않는다.
- 기존 인증 묶음의 단일 계정 형식 검사는 그대로 유지한다. 승인 binding의 `bundle_sha256`(인코딩 문자열의 SHA-256)과 `credential_path`로 정확한 묶음·계정을 고정한다. 권한 확인 후 서버 메모리에서 선택된 authorized_user JSON의 원본 바이트만 root credentials.json으로 재포장하며, 다른 계정·cache·client 파일은 전달하지 않는다. 원본 Secret은 수정하지 않는다. 해시·필수 OAuth 필드·경로·archive 검사 실패 시 우회하지 않는다. `normalizeApprovedLegacyGwsBundle()`이 새 묶음을 기존 strict decoder로 재검증한다. 실제 계정 매핑 및 운영 binding 등록에는 별도 승인이 필요하다.
- migration 197은 빈 테이블만 만든다. 운영 binding 등록, 인증 묶음 이전, 배포는 별도 승인 작업이다.
- 단위 검증: `legacy-gws-runtime-binding.test.ts`, `../secret/legacy-gws-binding.test.ts`. 실제 PostgreSQL 권한 회수와 Google 종단 검증은 별도다.

## 프로젝트 소유 Google Connection

Google 실행 정체성은 기본적으로 Agent Project가 소유한다. 프로젝트 owner/admin/member는 서명된 OAuth 흐름 또는 Secure Input의 검증된 Google credential JSON으로 프로젝트 전용 GWS Connection을 만들 수 있다. JSON 입력은 `authorized_user`와 `service_account`만 허용하고, 서버가 필수 필드와 private key 형태를 검사한 뒤 단일 root `credentials.json` bundle로 포장한다. 원문 JSON은 채팅이나 응답으로 반환하지 않는다.

Service Account 저장 성공은 Gmail 사용자 데이터 접근 성공을 뜻하지 않는다. Workspace 도메인 관리자 위임과 delegated subject가 필요한 기능은 Provider read smoke 전까지 미검증이다. `users/<id>/credentials.json` 또는 다중 계정 bundle을 신규 프로젝트 Connection으로 선택하거나 자동 승격하지 않는다. 공용 결정: `workspace/decisions/2026-09-16-project-owned-google-connections.md`.

## 인증 전략

Credential Vault가 모든 인증 lifecycle을 소유하지는 않는다.

- 고정 API key, password, token, private key, 검증된 JSON: Vault Credential
- Google 등 Provider OAuth: Provider Connection adapter가 OAuth lifecycle을 소유
- Higgsfield처럼 CLI가 refresh token을 직접 갱신하는 로그인: Project의 영속 CLI session file이 소유

CLI session을 일회성 Vault snapshot으로 주입하면 refresh token 회전 결과가 사라질 수 있으므로 두 모델을 섞지 않는다.

## Public service API

- `upsertApiKeyCredential()` — 팀 공용 또는 Agent 전용 API-key Credential을 생성하거나 값을 교체한다.
- `listWorkspaceCredentials()` — `workspace` 또는 특정 `project_id`의 Credential metadata를 조회한다.
- `updateCredentialLifecycle()` — Credential을 활성화하거나 비활성화한다.
- `deleteCredential()` — Credential metadata와 더 이상 참조되지 않는 Secret을 삭제한다.
- `resolveRuntimeBoxApiKeyEnv()` — 현재 Agent가 사용할 수 있고 명령이 요청한 환경변수만 Runtime에 주입한다.
- `resolveRuntimeBoxCredentialFileMaterialization()` — JSON/file Credential을 명령 범위의 임시 파일로 materialize한다.
- `resolveProjectCredentialSecretValue()` — Provider/CLI adapter가 지정 Credential을 서버 내부에서 해석한다.
- `revealCredentialValue()` — trusted 내부 Agent의 명시적 값 열람을 수행하고 audit한다.
- `copyProjectCredential()` — 양쪽 Agent의 연결 관리 권한으로 다른 Agent의 전용 Credential을 Secret Store 내부의 독립 사본으로 가져온다.
- `previewHostSecretImport()` / `applyHostSecretImport()` — allowlist된 host `.env` 값을 Agent 전용 Credential로 가져오는 제한된 migration bridge다.

## Project 간 가져오기

가져오기는 원본 record나 `secret_name`을 공유하지 않는다.

1. source Agent 전용 Credential의 값을 서버 내부에서 읽는다.
2. target Agent용 새 Secret과 새 `workspace_credentials` record를 만든다.
3. source/target 식별자를 metadata와 audit event에 기록한다.

따라서 원본의 교체·비활성화·삭제가 대상 Agent에 암묵적으로 전파되지 않는다.

## 관리 원칙

- 팀 공용 전환은 회사 관리자(operator/admin) 권한과 명시적인 범위 확대 확인이 필요하다.
- 공용 연결을 사용하는 member가 공용 원본을 교체·삭제·값 보기 할 권한까지 얻지는 않는다.
- 값 보기의 감사 저장에 실패하면 비밀값을 반환하지 않는다. env/file materialization도 감사 성공 이후에만 반환한다.
- UI와 Agent 자연어 도구는 동일한 서버 권한 검사와 audit 경로를 사용한다.
- Secret 값은 chat, Git, 로그, 테스트 fixture, 재사용 문서에 기록하지 않는다.
- 과거 policy/profile/default/intent 테이블은 migration 역사에만 존재하며 현행 API로 복원하지 않는다.

## 커넥션 관리 화면 계약

- 한국어 탐색·목록의 제품명은 **커넥션**이며, 범위는 **이 에이전트 전용** / **팀 공용**으로 구분한다. 인증 동작인 “연결”과 내부 Credential/API 식별자는 별개다.
- 관리자 커넥션 화면은 Google Workspace 계정을 `/api/auth/google/organization`의 `mode=create`로 추가하고, 기존 GWS 항목은 `mode=reauth`와 정확한 `credentialId`로 재인증한다. 시작 전에 모든 일반 에이전트가 사용할 수 있다는 범위를 확인한다. OAuth 결과는 관리자 커넥션 탭으로 돌아와 표시한다.
- 에이전트 화면은 전용 관리 목록을 먼저 표시하고 동일 항목의 카탈로그 카드를 중복 표시하지 않는다. Google/API 키 모두 정지·재개·삭제를 제공한다. 정지는 `PATCH /projects/:projectId/credentials/:credentialId`, 삭제는 확인 후 동일 경로의 `DELETE`를 사용한다.
- 팀 공용은 자동 사용 정책을 유지한다. 에이전트 화면에서 팀 공용 원본을 정지·삭제하거나 프로젝트별 차단 정책을 만들지 않는다. 실행 중인 명령을 강제 중단하는 기능도 아니다.
- 구현: `packages/frontend/src/components/admin/AdminPanel.tsx`, `packages/frontend/src/components/layout/AgentCredentialsModal.tsx`, `AgentConnectionsPanel.tsx`, `packages/frontend/src/App.tsx`.
- 검증: `AgentCredentialsModal.test.tsx`의 정지·삭제 승인/취소·갱신 테스트, `AdminOrganizationGoogleConnection.source.test.ts`의 OAuth 계약 검사. 실제 Google 동의·운영 배포는 별도 검증 대상이다.

### 목록 중심 UI 후속 정리

에이전트 기본 화면은 전용 목록과 팀 공용 목록이다. 추가 버튼을 눌렀을 때만 Google/API 키/가져오기 선택을 표시한다. 정지·재개는 직접 조작하고 재인증·교체·이름 변경·삭제는 항목의 더 보기에서 조작한다. 환경변수/ID/수정일은 상세정보에 접는다. 추가 방식 변경·닫기는 미저장 비밀값을 비운다.

관리자는 팀 공용/에이전트 전용/변경 기록으로 조회 구역을 나눈다. 관리 목록 API가 실제 사용 수와 provider 인증 결과를 주지 않으므로 임의의 0개 사용·미검증 상태를 붙이지 않는다. UI 변경은 CLI 경고 억제나 실제 Provider 권한 철회를 포함하지 않는다.

## Connection continuity — implementation boundary

Existing responsibilities remain separate: `credential-management-access.ts` owns management authorization; `resolveProjectCredentialSecretValue()` owns runtime resolution; `getSecretForLegacyGwsBinding()` owns the frozen legacy audience; the GWS normalizer owns archive validation. Do not create a parallel resolver or resurrect removed profile/default policy tables.

`diagnoseProjectConnections()` isolates non-env resolution failures per connection without returning exception text. `deriveConnectionReadiness()` does not allow provider success to override materialization failure or missing materialization evidence.

`evaluateConnectionContinuity()` is a pure evidence evaluator for explicit project/user/connection cases. It requires permitted execution to have resolution, process-injection and read-only provider evidence, and forbidden execution to remain denied. Empty evidence never passes. It is not yet wired into deployment, does not collect evidence or prove its freshness/coverage, and does not migrate bindings. Callers must bind evidence to an exact target/revision/run and collect all approved cases before using it as a deployment gate.

Next migration integration must reuse management access and existing Secret Store/GWS normalization. Host import's preview/apply pattern is relevant, but its `.env` importer and API-key upsert are not a GWS migration implementation. An approved GWS plan must pin source identity and audience, reject stale state, atomically write binding plus audit, preserve the original, and remain pending until process/provider checks pass. No migration apply endpoint or automatic deployment gate is provided by this change.

## Unresolved Workbench requirements

`diagnoseUnresolvedCredentialRequirements()` adds metadata-only reasons for explicitly requested env names that the remote Workbench resolver did not select. It reads enabled team-shared/current-Agent rows only, never secret storage; it does not grant access or expose other Agents' records. `LegacyPersonalCredentialBlocked` preserves personal quarantine, `UnsupportedCredentialKind` identifies non-api-key candidates, `SelectionOrMaterializationFailed` identifies an eligible API-key candidate without successful selection, and `NoAccessibleMatchingCredential` does not prove that a Credential was never saved. Metadata matching uses `default_env_name`; aliases/file-path outputs still require checking the selection evidence.

`workbenchCredentialDiagnostics()` keeps `unresolved_env_names` and adds `unresolved_reasons`. These are selection evidence, not provider authentication or actual process materialization. Admin credential badges say “Stored · enabled” rather than asserting execution readiness. Tests: `credential-requirement-diagnostics.test.ts`, `../runtime-box/workbench-credential-diagnostics.test.ts`, and `../runtime-box/workbench-remote-credential-resolution.test.ts`.
