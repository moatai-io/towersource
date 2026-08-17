# Agent Harness 설계서 — quick-web-research

## 1. 기본 정보

- Agent 이름: Quick Web Researcher
- Harness 이름: `quick-web-research`
- Harness version: `1`
- Runtime Profile: `web-only@1`
- 대상 사용자: 짧은 공개 웹 조사가 필요한 Tower 사용자
- 공개 범위: internal pilot

## 2. 한 문장 실행 계약

> 이 Agent는 공개 웹 검색과 페이지 읽기로 짧은 출처 기반 답변을 만들며, 파일·프로젝트 작업·다른 AI 호출·외부 게시를 하지 않는다.

## 3. 업무 범위

### 해야 하는 일

- 주제에 맞는 공개 웹 결과 검색
- 중요한 결과 URL의 본문 확인
- 출처·한계가 드러나는 짧은 조사 답변

### 하지 않는 일

- 다른 Agent나 Worker 호출
- Session 간 메시지 전송
- 프로젝트 파일과 과거 대화 검색
- 코드 실행·파일 생성·외부 게시
- 장기·다단계 리서치 프로젝트 수행

## 4. Engine과 모델

- Engine: `pi` 고정
- 기본·유일 모델: `litellm-responses/smart`
- Engine switch: 금지
- 다른 모델 요청: fail-closed

## 5. Capability Manifest

| Capability ID | Tool | 권한 | 위험 | 비고 |
|---|---|---|---|---|
| `web.search` | `WebSearch` | execute | medium | 공개 웹·뉴스 검색 |
| `web.fetch` | `WebFetch` | execute | medium | 선택 URL 읽기 |

그 외 capability는 장착하지 않는다.

## 6. 실행 환경

- Filesystem: none
- Sandbox: none
- Runtime Box: none
- MCP: none
- Skills: none
- Memory: none
- Project instructions: none
- Network: WebSearch/WebFetch tool contract를 통해서만 사용

## 7. Credential

- Agent가 Credential을 입력·열람·회전하지 못함
- Web tool 내부에서 이미 승인된 Firecrawl service/project grant만 해석 가능
- Secret 값은 prompt·Session·로그에 노출하지 않음

## 8. Session과 호출

- 일반 Session: 명시적 `harnessId=quick-web-research`
- `quickReply()`: 동일 Harness resolver를 거쳐야 함
- Channel: 호출된 Researcher Agent의 이 Harness snapshot 사용
- Channel audience·Project ACL: 매 호출 재검사
- 다른 Agent/Worker: 호출 불가

## 9. Fail-closed

- Harness ID 미해석
- Smart 외 모델
- Tool surface가 정확히 `WebFetch`, `WebSearch`가 아님
- MCP가 하나라도 장착됨
- Channel caller/Agent/audience/resource 미해석

## 10. 검증

- [ ] Tool names = `WebFetch`, `WebSearch`
- [ ] MCP count = 0
- [ ] Model = `litellm-responses/smart`
- [ ] File/Bash/Runtime Box/Spawn/Worker tool 없음
- [ ] Memory/Skills/Project instruction 미주입
- [ ] 알 수 없는 Harness와 금지 모델 fail-closed
- [ ] `tower-default` 회귀 없음
