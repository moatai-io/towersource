# Decisions

- LiveKit은 음성 전면부이며 Tower Session을 대체하지 않는다.
- 한국어 TTS 기본 adapter는 Typecast이고 ElevenLabs는 비교·fallback 경로다.
- 빠른 응대는 새 사실을 만들지 않는 규칙 기반 문장부터 시작한다.
- 음성 연결은 ephemeral in-memory state이고, transcript와 최종 답변만 기존 message store에 남긴다.
- `ws-handler.ts`의 Agent 실행 로직을 복사하지 않는다. 공통 session-turn 진입점이 생기면 그 경계를 호출한다.
