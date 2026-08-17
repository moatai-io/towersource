<!--
PR 본문은 자유롭게 작성하세요.
체크박스는 "해당 없음"이면 그대로 비워두고 본문에 한 줄 사유 적으면 됩니다.
모든 항목 필수가 아니라, 변경 범위에 따라 골라 사용하는 가이드입니다.
-->

## 요약
<!-- 1-3 줄로 무엇을 왜 바꿨는지 -->

## 변경 범위
<!-- 영향 받는 영역 체크 (해당하는 것만) -->

- [ ] Frontend (UI / 라우팅 / store)
- [ ] Backend (API / 서비스 / DB)
- [ ] Engine (claude / pi / local)
- [ ] DB 스키마 (migration 추가)
- [ ] Infra / 배포 / nginx
- [ ] Skills / 시스템프롬프트 / 컨텍스트

## AI 실행 경로 영향 검토

> Tower의 AI 호출 경로는 3가지로 분기되어 있습니다 — Session(UI), Channel AI(`@ai`), Task(`@task`).
> 한 경로만 고치고 다른 둘을 잊는 사고가 반복되어 SOT을 만들어두었습니다.
> **하나라도 만지는 PR이면 이 섹션을 채워주세요.**

- [ ] 본 PR은 AI 실행 경로(`packages/backend/engines/`, `services/ai-quick-reply.ts`, `services/task-runner.ts`, `services/system-prompt.ts`, `services/claude-sdk.ts`, `services/project-access.ts` 중 하나)를 수정합니다 → 아래 체크리스트 진행
- [ ] 또는 이 PR은 위 영역과 무관합니다 → 이 섹션 건너뛰기

해당하면 모두 체크:

- [ ] `docs/tower-guide/ai-execution-paths.md` §1 매트릭스에 변경 반영
- [ ] 다른 두 경로에서는 의도적 제외인 경우, 코드 주석 또는 결정 문서에 사유 기록
- [ ] systemPrompt 변경 시 `'chat'` / `'task'` 모드 둘 다 의도대로 동작 확인
- [ ] canUseTool/buildToolGuard 변경 시 채널 AI(가드 미적용 경로) 영향 명시
- [ ] resume / .jsonl / cwd 관련 변경 시 채널 AI 매-호출 cwd 재해결 패턴과 충돌 없음 확인
- [ ] Pi/Local 엔진 fallback 동작 비파괴 확인 (특히 `channelReply` 미구현 엔진)

## 테스트
<!-- 어떻게 검증했는지 -->

- [ ] `npx tsc -p packages/backend/tsconfig.json --noEmit` 깨끗
- [ ] `npx tsc -p packages/frontend/tsconfig.json --noEmit` 깨끗
- [ ] `npm test` 또는 관련 vitest 통과
- [ ] dev 환경(`desk-dev.tower.example.com`)에서 수동 확인
- [ ] (DB 스키마 변경 시) prod 배포 전 마이그레이션 시뮬레이션

## 결정 / 영향 기록
<!-- 아키텍처/정책 결정이 있으면 -->

- 결정 문서: `workspace/decisions/YYYY-MM-DD-title.md` (해당 시)
- 영향 받는 사용자/자체 호스팅 서버:
- 롤백 방법:

## 리뷰 요청 포인트
<!-- 리뷰어가 특히 봐줬으면 하는 부분 -->
