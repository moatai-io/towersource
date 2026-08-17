# publishing/_DECISIONS.md

이 모듈의 구조 선택 — AI 가 잘못된 합치기/분리 제안 차단용.

- **Hook 과 reconciler 분리 (vs 단일 cron)**: hook 은 realtime, reconciler 는 5분 batch — 두 timescale 이 의도된 redundancy. 합치지 말 것. 한쪽만 두면 cover 영역에 구멍 생김 (hook only → Bash/ssh 미스, reconciler only → 5분 lag 동안 Hub 데이터 stale).
- **register.ts 의 `registerSiteInManifest` 가 진입점 (vs deploy-engine.ts 재사용)**: deploy-engine.ts 의 `updateSiteAccess` 류는 *user-facing* mutation (access/archive/태그). 이 모듈은 *infrastructure* mutation (자동 추적) 이라 의미·실패 모드·로깅 다름. 같이 묶으면 두 의도가 한 함수에 섞임.
- **Bash tool 은 hook 이 안 잡고 reconciler 에 맡김**: Bash command 파싱 (mkdir/touch/cp/tar 분기) 이 fragile. reconciler 5분 lag 안에 잡힘.
- **Slug regex `^[a-z0-9][a-z0-9-]*$` 가 빡빡함**: 한글/언더스코어 등 거름. 사용자가 명시 슬러그 만들 때는 이 규칙 따라야 nginx wildcard 도 동작 (도메인 제약과 일치).
