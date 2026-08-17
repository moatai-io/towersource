# Agent Harness 설계서

> 이 문서는 Agent가 **누구인지**가 아니라, 어떤 실행 체계와 도구를 가지고 어떤 경계 안에서 일하는지를 정의한다. Agent의 역할·약속·행동 원칙은 Employee Card/Agent Profile/AGENTS.md에 두고, 이 문서에는 실행 능력과 제한만 기록한다.

## 1. 기본 정보

- Agent 이름:
- Agent/Project ID:
- Harness 이름:
- Harness version: draft
- Runtime Profile:
- 소유 조직/Project:
- 대상 사용자:
- 공개 범위: private | internal | unlisted | public
- 설계 책임자:
- 마지막 검토일:

## 2. 한 문장 실행 계약

> 이 Agent는 `[대상 업무]`를 위해 `[핵심 capability]`를 사용하며, `[절대 넘지 않을 경계]` 밖의 행동은 하지 않는다.

## 3. 업무 범위

### 해야 하는 일

-
-
-

### 하지 않는 일

-
-
-

### 사람의 승인이 필요한 일

-
-

## 4. Engine과 모델 정책

- 고정 Engine: `pi`
- 허용 모델:
  -
- 기본 모델:
- 모델 변경 조건:
- 금지 모델/Provider:
- Context window 또는 비용 제한:

원칙:

- Session 도중 Pi ↔ Claude처럼 Engine을 바꾸지 않는다.
- 모델 변경은 같은 Engine 안에서만 가능하며 Harness의 모델 정책을 통과해야 한다.

## 5. Capability Manifest

각 capability는 장착 여부와 권한을 구분한다. “도구가 없음”과 “권한이 없음”을 섞지 않는다.

| Capability ID | 종류 | 목적 | 노출 | 권한 | 위험 등급 | 승인 필요 | 비고 |
|---|---|---|---|---|---|---|---|
| 예: `workspace.files` | native-tool | 프로젝트 파일 읽기 | enabled | read | medium | no | 프로젝트 root 한정 |
|  |  |  |  |  |  |  |  |

권장 종류:

- `native-tool`
- `tower-tool`
- `mcp-server`
- `context-provider`
- `artifact-export`
- `orchestration`

권장 권한:

- `discover`
- `read`
- `write`
- `execute`
- `publish`
- `admin`

미분류 capability는 실행하지 않는다.

## 6. Tool과 MCP

### 허용 Tool

-

### 허용 MCP/외부 연결

-

### 명시적으로 제외할 Tool/MCP

-

### 충돌과 실패 처리

- Tool 이름 충돌 우선순위:
- MCP 연결 실패 시: fail-closed | degraded mode
- 외부 Provider 장애 시 fallback:

## 7. Credential과 Secret

| Credential/Grant | 사용 목적 | Scope | 허용 작업 | 주입 위치 | 로그 정책 |
|---|---|---|---|---|---|
|  |  | project/personal/workspace | read/write 등 | Runtime Box/MCP/tool closure | 값 비노출 |

원칙:

- Secret 값은 Harness manifest, prompt, Session snapshot, 로그에 저장하지 않는다.
- Harness가 capability를 장착해도 Credential grant가 없으면 실행할 수 없다.
- Host 전체 환경을 외부 process에 상속하지 않는다.

## 8. Workspace·Sandbox·Network

- Workspace 범위:
- Filesystem mode: none | read-only | project-write | scoped-multi-project
- Sandbox mode: none | runtime-box | managed-sandbox | host
- Network mode: none | allowlist | platform-default
- 허용 domain:
  -
- 금지 domain:
  -
- Runtime/resource limits:

## 9. Prompt Plan

### 항상 포함

- Tower Platform Kernel
- Agent identity/version
- Harness identity/version
- 현재 사용자와 Project authority

### 선택 포함

- Project AGENTS.md: yes | no
- Session memory: yes | no
- Skills: yes | no
- 연결 Knowledge/자료:
- Harness 전용 prompt fragment:

### 포함하지 않음

- 비노출 Tool 설명
- 접근할 수 없는 Project/채널 자료
- Secret 또는 Credential 값

## 10. Session Snapshot과 변경 규칙

Snapshot에 포함:

- Agent profile/version
- Harness id/version/fingerprint
- Runtime Profile/version
- Engine과 모델 정책
- Effective capability set
- Prompt plan hash
- Authority/resource scope

변경 규칙:

- 발행된 Harness version은 제자리 수정하지 않는다.
- 기존 Session은 기존 snapshot을 유지한다.
- 새 version 적용은 새 Session 또는 명시적 repin으로 한다.
- Helper/Worker는 부모 Harness를 상속하지 않고 자체 Harness를 backing Session에 pinning한다.
- `quickReply()`도 Harness resolver를 통과한다.

## 11. Channel 호출 계약

Channel 전용 익명·범용 Harness를 만들지 않는다. 채널에서 호출된 **특정 Agent 자신의 Harness snapshot**을 사용한다.

```text
Effective Channel Capability
= Agent Harness Capability
∩ Agent Authority
∩ 호출자 Authority
∩ 채널 청중 공통 권한
∩ 연결 Resource Scope
∩ Credential / Publication Policy
```

- `@Agent`: 해당 Agent binding 사용
- legacy `@ai`: 채널 기본 Agent를 가리키는 compatibility alias
- Harness version: Session에 pinning
- Audience와 Project ACL: 매 호출 재검사
- Agent/caller/audience/resource/capability 미해석: fail-closed
- System-owned admin Harness fallback: 금지

이 Agent의 Channel 정책:

- 채널 호출 허용: yes | no
- 허용 채널/그룹:
- 연결 가능한 Resource 종류:
- 공개 응답 제한:
- 비공개 Session 전환 조건:

## 12. Helper·Worker 정책

- 이 Agent가 생성할 수 있는 Helper:
- 각 Helper의 자체 Harness:
- Parent가 넘길 수 있는 context:
- Parent가 넘길 수 없는 authority/credential:
- Worker follow-up 시 backing Session snapshot 유지 방식:
- Legacy Helper fallback 허용 여부:

## 13. Publication 정책

- 외부 공개 가능: yes | no
- Public-compatible Harness 필요: yes | no
- 공개 시 제거할 capability:
- 공개 응답의 데이터 등급:
- 승인자:
- 공개 version 고정/rollback 방식:

## 14. 실패 처리

다음은 fail-closed한다.

- Agent identity 또는 binding 없음
- Harness/version 없음
- 호출자 없음
- Authority/ACL 미해석
- Capability 위험 등급 미분류
- 필요한 Credential grant 없음
- Snapshot과 in-memory runtime fingerprint 불일치

허용할 degraded mode:

-

사용자에게 보여줄 오류 원칙:

- 할 수 없는 이유를 권한·연결·승인·장애 중 하나로 구분한다.
- 내부 Secret, hidden prompt, private resource 이름은 노출하지 않는다.

## 15. 검증 시나리오

### Golden default

- [ ] Tool 이름·schema fingerprint가 승인된 fixture와 일치
- [ ] 필수 security/approval/audit hook 존재
- [ ] Prompt에는 노출 Tool만 설명

### 권한

- [ ] 읽기 허용
- [ ] 쓰기 차단
- [ ] 직접 dispatcher 우회 차단
- [ ] Credential 미주입 확인
- [ ] Network/Sandbox 제한 확인

### Session

- [ ] create/resume/restart 후 fingerprint 불변
- [ ] 허용 모델 변경 성공
- [ ] 금지 모델 변경 거부
- [ ] Engine 변경 거부
- [ ] Helper/Worker 자체 snapshot 유지
- [ ] `quickReply()` Harness 적용

### Channel

- [ ] 특정 Agent Harness 사용
- [ ] 호출자 없는 실행 거부
- [ ] 청중 확대 후 공개 범위 재계산
- [ ] 연결 Resource가 capability를 확대하지 않음
- [ ] legacy `@ai`가 기본 Agent로만 resolve
- [ ] system/admin fallback 없음

## 16. 관측과 감사

구조화 로그/Inspector에 남길 값:

- Agent ID/version
- Harness ID/version
- Runtime Profile/version
- Resolution source
- Engine/model
- Tool set hash
- Prompt plan hash
- Authority/resource hash
- 호출 형태: session | channel | quick-reply | task | proactive | worker
- Denied capability와 사유
- Snapshot mismatch 여부

남기지 않을 값:

- Secret
- Raw credential payload
- 전체 private prompt
- 불필요한 개인 데이터

## 17. 출시와 롤백

- Feature flag:
- Canary 대상:
- 기존 Session 처리:
- 새 Session opt-in 방식:
- Kill switch:
- Rollback 시 유지할 snapshot:
- 성공 지표:
- 중단 기준:

## 18. 미해결 질문

-
-

## 19. 승인

- [ ] Agent 책임과 Harness 책임이 분리되어 있다.
- [ ] Capability가 업무 언어와 risk class로 설명되어 있다.
- [ ] Helper/Worker/quickReply/Channel 경로가 빠지지 않았다.
- [ ] Fail-closed 조건과 degraded mode가 구분되어 있다.
- [ ] Session snapshot과 rollout/rollback이 정의되어 있다.
- [ ] 보안·운영 검증을 통과했다.

승인자:

승인일:
