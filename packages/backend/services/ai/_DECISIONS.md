# ai 모듈 — 구조 결정

## 왜 7 파일이 한 폴더에 묶였나

claude-sdk, pi-session-runtime (엔진별 SDK 어댑터), ai-dispatch / ai-quick-reply (채팅 AI 라우팅), utility-agent / summarizer (보조 task), proactive-agent (능동 알림) — 모두 "AI 호출" 도메인. 인터페이스는 다양해도 SDK / 모델 / 컨텍스트 윈도우 고민이 같음. 한 폴더로 묶으면 AI-related 작업을 한 곳에서 발견.

## 왜 claude-sdk 와 pi-session-runtime 이 분리됐나

엔진별 SDK 가 디자인이 다름:
- Claude SDK = subprocess 모드 (별도 프로세스, IPC)
- Pi = in-process (같은 노드 프로세스 안)

orphan 정리 / backup 전략 / resume 메커니즘 모두 다름. 추상화하면 두 엔진의 차이를 가리는 leaky abstraction. **명시적 중복 > 어색한 베이스 클래스.**

대신 *상위* engine 인터페이스 (engines/types.ts) 가 두 엔진을 통합 → 호출자는 둘 차이 모름.

## 왜 ai-dispatch 와 ai-quick-reply 가 분리됐나

- **dispatch** = 멘션 감지 + rate limit + 권한 검증 (stateless utility, fast)
- **quick-reply** = 실제 AI 호출 + 룸별 세션 + 응답 처리 (stateful, slow)

합치면:
- 단위 테스트 어려움 (rate limit 만 검증하려고 SDK mock 필요)
- "이 요청 거부됨" 플로우가 SDK 호출 직전에 위치 → 코드 가독성 ↓

분리하면 dispatch 가 게이트키퍼, quick-reply 가 작업자. 흐름 명확.

## 왜 utility-agent 가 engine 추상화를 거치나 (claude-sdk 직접 안 부르고)

utility-agent 는 generic — Claude / Pi 어느 모델로도 짧은 텍스트 task 가능. engineFromModel 로 모델 ID 보고 라우팅. 호출자 (auto-namer, summarizer) 는 모델 신경 안 씀.

## 왜 summarizer 가 utility-agent 위에 얇게만 있나

summarizer = utility-agent 의 한 use case (language-resolver 로 prompt 언어 결정 + "이거 요약해줘" prompt). 별도 SDK 호출 로직 필요 없음. utility-agent 의 wrapper. 분리한 이유: 호출자 의도 분명 (`generateSummary`), 향후 요약 정책 (압축률, 형식) 변경 시 한 곳만 수정.

## 왜 proactive-agent 가 broadcastFn 을 inject 받나

순환 의존 차단:
- proactive-agent → 알림 발송 → ws-handler.broadcast
- ws-handler → 채팅 처리 → ai-quick-reply (ai/)
- ai-quick-reply → ai 응답 → proactive 트리거 가능

import 그래프로 풀면 ws-handler ↔ ai/ 가 양방향 → 순환. inject 패턴으로 한쪽 끊음. 부팅 시점 (index.ts) 에서 broadcastFn 을 proactive-agent 에 주입.

## 왜 claude-sdk 가 services/auth/auth.js 를 dynamic import 하나 (static 아님)

generateScopedToken 호출 = sandbox 모드 시에만. 일반 query 흐름엔 불필요. dynamic import 로 lazy load → 부팅 시 auth 모듈 미로딩, sandbox 사용 시점에 1회 import 후 캐시. 정적 import 면 항상 로딩 cost.
