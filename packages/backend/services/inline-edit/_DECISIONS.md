# inline-edit — 모듈 내부 결정

1. **AI 호출과 파일 I/O 분리.** `runInlineEdit` 는 selection→replacement 변환만.
   파일 읽기/쓰기/권한은 라우트 레이어가 책임. 이유: AI 호출은 utility-agent
   와 결합하지만 권한·rate-limit·audit 은 HTTP 컨텍스트가 있어야 깔끔.

2. **Sonnet 4.6 default, Haiku 옵션 가능.** 따옴표·들여쓰기 fidelity 가
   Phase 1 핵심이라 비용보다 안정성 우선. `model` 옵션으로 호출 측에서 override.

3. **fallback 은 selection 그대로.** 모델 비활성/네트워크 실패 시 원본을 그대로
   반환 → 프론트의 diff 미리보기가 "변경 없음" 으로 표시되고 사용자가 다시
   시도. throw 보다 부드러운 실패 경로.

4. **Sanitize 는 보수적으로.** 진짜 사고난 케이스만 잡음 (전체가 fence 로 감싸진
   경우, 명백한 preamble). 선택 자체가 따옴표로 감싸여 있던 경우는 손대지
   않도록 `originalSelection` 을 비교.

5. **Audit 은 try/catch 로 감싸 throw 안 함.** provenance.jsonl 쓰기 실패가
   사용자 요청을 죽이면 안 됨. 로그만 남김.

6. **워크스페이스 위치는 `process.env.WORKSPACE_ROOT || os.homedir()`** —
   `config.workspaceRoot` 와 동일 패턴. `/workspace/.audit/` 한 단계 더 들어감.
