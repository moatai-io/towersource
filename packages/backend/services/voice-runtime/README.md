# Voice Runtime

## 책임

기존 Tower Session에 연결되는 짧은 수명의 한국어 음성 연결을 관리한다. 미디어 연결과 TTS/STT 공급자는 교체 가능하게 두며, 대화 기록과 업무 실행의 정본은 기존 Tower Session이다.

## Public API

- `createVoiceRouter()` — 인증 뒤 mount하는 voice HTTP boundary
- `VoiceSessionManager` — ephemeral voice lifecycle
- `createLiveKitAccessFactory()` — microphone-only 단기 room token 발급
- `createLiveKitInferenceSession()` — 1차 PoC의 LiveKit Inference 한국어 STT·TTS pipeline
- `createTowerVoiceDelegate()` — 기존 Tower Agent turn으로 넘기는 좁은 callback 경계
- `ClovaStreamingStt` — 2차 품질 개선용 16kHz mono PCM 기반 CLOVA gRPC streaming STT
- `TypecastTtsProvider` — 기본 한국어 streaming TTS
- `ElevenLabsTtsProvider` — 비교·fallback TTS
- `buildSafeAcknowledgement()` / `normalizeSpokenAnswer()` — 짧은 음성 응답 정책

## 들어오기 전 알아야 할 것

- 이 모듈은 Tower Agent turn을 새로 구현하지 않는다.
- 기본 경로는 `deepgram/nova-2:ko-KR` STT와 검증된 `cartesia/sonic-3` TTS다.
- Inworld `Seojun`은 독립 PCM smoke를 통과했지만 명시적 opt-in이다. `TOWER_VOICE_TTS_PROVIDER=inworld`일 때만 활성화하며, 미지정·오타는 Cartesia를 유지한다.
- final STT transcript는 voice-only capability token을 통해 기존 `handleChat` 경로로 전달되어 Tower Session에 저장되고 처리된다.
- provider credential은 backend Runtime에서만 사용하며 브라우저에 전달하지 않는다.
- `voice-router.ts`는 반드시 `authMiddleware` 뒤에 mount한다.
- LiveKit access callback은 의존성으로 받는다. `buildLiveKitAccessFromEnv()`는 `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`이 모두 있을 때만 callback을 만든다.
- CLOVA streaming은 공식 계약대로 `clovaspeech-gw.ncloud.com:50051`, Bearer secret key, 16kHz·mono·16-bit headerless PCM을 사용한다.
- CLOVA streaming은 Basic 장문 인식 플랜 이상이 필요하다.

## 관련 설계

- `docs/plans/2026-08-11-korean-voice-runtime-design.md`
