# publishing/

게시된 사이트 manifest 의 *자동 추적* 을 담당하는 모듈. AI 가 어떤 패턴으로 사이트를 만들든 (mkdir + Write 직접 / hybrid symlink / `/api/deploy`) Hub UI 가 그룹/필터/태그 기능을 정상 동작시킬 수 있도록 manifest 에 entry + project attribution 을 자동 채움.

## Public API

| 함수 | 호출자 | 역할 |
|---|---|---|
| `registerSiteInManifest(slug, project?)` | hook + reconciler 공통 | idempotent 등록 — promote / fill / no-op 셋 중 하나 |
| `postToolUsePublishingTracker` | `claude-sdk.ts` `queryOptions.hooks.PostToolUse` | 매 Write/Edit/NotebookEdit 직후 즉시 manifest 갱신 |
| `startReconciler / stopReconciler` | `index.ts` boot | 5 분마다 disk → manifest 동기화. hook 이 놓친 사이트 (Bash 로 만든 것 / backend down 중 만든 것 / ssh 직접) safety net |

## 들어오기 전 알아야 할 것

- **manifest 의 진실** = `workspace/published/manifest.json`. nginx 는 단순히 disk 를 서빙하지만, Hub UI 의 그룹/필터/access tier/태그/휴지통 모두 manifest 메타데이터에 의존. 따라서 disk 에만 있고 manifest 에 없는 사이트 = 기능 깨짐.
- **slug 정규식**: `^[a-z0-9][a-z0-9-]*$`. dotfiles, robots.txt, 임시 파일은 자동 필터.
- **project 추출**: `workspace/projects/<project>/...` 패턴에서 `<project>` 만 뽑음 (`deriveProjectFromPath`).
- **idempotent**: 같은 slug 에 대한 100 번 호출 → 최종 상태는 1 번 호출과 동일. 사용자가 명시한 project 는 절대 덮어쓰지 않음 (manifest 가 user intent 의 source of truth).

## 두 layer 의 역할 분담

```
┌────────────────────────────┐    ┌──────────────────────────────┐
│ Layer 1: PostToolUse hook  │    │ Layer 2: Reconciler (5 min)  │
│ (realtime, ms 레벨)         │    │ (safety net, batch)          │
├────────────────────────────┤    ├──────────────────────────────┤
│ AI Write/Edit/NotebookEdit │    │ Bash mkdir → 사이트 폴더 생성  │
│ → 매 호출 즉시 manifest     │    │ ssh 직접 작업 / cron 결과     │
│   갱신                      │    │ backend 다운 중 만들어진 것    │
│                            │    │ → 5분 안에 따라잡음           │
│ ✅ Tower SDK 거치는 모든    │    │ ✅ 어떤 source 든 결국 잡음    │
│   AI 세션 (config home 무관)│    │                              │
│ ❌ Bash 로 만든 사이트 미스  │    │ ❌ 5분 lag                    │
└────────────────────────────┘    └──────────────────────────────┘
                ↓                                ↓
         registerSiteInManifest(slug, project?) — 공통 진입점
                                ↓
                          manifest.json
```

두 layer 가 같은 `registerSiteInManifest` 를 호출 — 동일 idempotency, 동일 결과. 호출 빈도와 source 만 다름.

## 결정 문서 (왜 이렇게)

- `workspace/decisions/2026-05-09-tower-hooks-via-sdk-options.md` — 외부 `.claude/hooks/*.mjs` 가 아니라 SDK Options.hooks 안에 inline JS 로 박는 이유 (multi-config-home 호환)
- `workspace/decisions/2026-05-08-publishing-hub-archive-and-tags.md` — Hub UI 의 휴지통/태그/그룹 기능 (이 모듈이 그 기반)
- `workspace/decisions/2026-04-26-publishing-storage-redesign.md` — hybrid storage (`projects/<p>/published/<slug>/` symlink)
- `workspace/decisions/2026-04-23-publishing-visibility-redesign.md` — 4-tier access

## 가이드 — 새 hook 추가 시

이 모듈은 *publishing 도메인 한정*. 다른 도메인의 hook (예: Slack 알림, audit log) 은 *별도 feature 폴더* 에 같은 패턴으로:

```
services/<your-feature>/
├── README.md          # 이 파일처럼 책임 + Public API
├── _DECISIONS.md      # 왜 이런 구조 (3~5줄)
├── hook.ts            # PostToolUse / Stop / SessionStart 등 callback
└── (보조 파일)
```

`claude-sdk.ts` 의 `queryOptions.hooks` 에 wire. 외부 `.claude/hooks/*.mjs` 금지 — 근거는 위 결정문서.
