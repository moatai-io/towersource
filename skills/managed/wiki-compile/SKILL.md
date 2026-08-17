---
name: wiki-compile
description: >
  프로젝트 파일·기록·결정·대화를 Karpathy식 LLM Wiki 패턴으로 증류해
  .wiki/ minimal knowledge layer를 생성·갱신·점검한다. raw 파일은 옮기거나
  수정하지 않고, .wiki/index.md와 .wiki/pages/ 중심으로 컴파일한다.
context: fork
agent: general-purpose
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: "[project-path] [--init | --reindex | --ingest <path> | --lint | --full | --export]"
---

# wiki-compile — `.wiki` 프로젝트 지식 컴파일러

프로젝트 폴더의 raw 파일, 기록, 결정, 대화 단서를 읽어 `.wiki/` 안에 LLM-maintained markdown wiki를 구축한다. 목적은 RAG처럼 매번 raw 조각을 재조립하는 것이 아니라, 지식을 **지속적으로 갱신되는 wiki page**로 누적하는 것이다.

## 핵심 원칙

1. **raw는 절대 수정하지 않는다** — 원본은 source of record다.
2. **정본 target은 `.wiki/`다** — `wiki/`는 과거 visible index 또는 export/snapshot 후보일 뿐이다.
3. **minimal v1로 시작한다** — 기본 구조는 `README.md`, `schema.md`, `index.md`, `log.md`, `pages/`뿐이다.
4. **page가 핵심 단위다** — concept/map/synthesis 구분은 폴더가 아니라 page frontmatter와 index metadata로 표현한다.
5. **출처를 남긴다** — 중요한 page는 `sources:` frontmatter 또는 `Sources` 섹션을 가진다.
6. **점진적 컴파일** — 한 번에 다 하지 않는다. 호출할 때마다 조금씩 더 좋아진다.
7. **기존 구조 존중** — 프로젝트 파일을 사용자 확인 없이 이동하지 않는다.
8. **주기 실행 가능** — Task Schedule이 호출해도 안전해야 하며, 새/변경 자료를 자동 탐지해 `.wiki`만 갱신한다.
9. **과잉 구조화 금지** — `claims/`, `sources/`, `inject/`, `lint/`, `cache/` 같은 세부 ledger/cache 폴더는 반복 필요가 검증될 때만 추가한다.

## 사용법

```text
/wiki-compile                       # 현재 프로젝트 기본: --reindex
/wiki-compile /path/to/project      # 특정 프로젝트
/wiki-compile --init                # .wiki minimal 구조 생성/보강
/wiki-compile --reindex             # .wiki/index.md 갱신
/wiki-compile --ingest <path>       # 특정 source를 읽고 관련 pages/index/log 갱신
/wiki-compile --lint                # 위키 건강 점검, 기본은 log에 결과 기록
/wiki-compile --full                # 새/변경 자료 자동 탐지 → pages/index/log 갱신
/wiki-compile --export              # 사람이 볼 수 있는 wiki/ 또는 final/wiki-export/ snapshot 제안/생성
```

## Step 0: 프로젝트 경로 결정

인자가 없으면 현재 세션의 프로젝트 폴더를 사용한다. 인자가 있으면 해당 경로가 접근 가능한 project root인지 확인한다.

- 파일 쓰기는 대상 프로젝트 안에서만 한다.
- 다른 프로젝트를 명시한 경우에도 raw 파일 이동/삭제/덮어쓰기는 사용자 확인 없이는 하지 않는다.

## Step 1: `.wiki` 구조 확인/초기화

`--init` 또는 `.wiki`가 없을 때 다음 minimal 구조를 만든다.

```text
.wiki/
├── README.md
├── schema.md
├── index.md
├── log.md
└── pages/
```

### README.md에 담을 내용

- `.wiki`는 derived knowledge이며 source of record가 아님
- raw 파일, 기록, 결정, 최종 산출물은 원본 권위를 유지함
- LLM이 주로 쓰고 사람은 읽고 검토함
- 구조는 작게 시작하고 필요할 때만 확장함

### schema.md에 담을 내용

- ingest/query/lint 규칙
- page convention
- source/provenance 기록 방식
- 확장 구조를 언제 추가할지에 대한 기준

이미 `.wiki/README.md` 또는 `.wiki/schema.md`가 있으면 덮어쓰지 말고 필요한 최소 보강만 제안한다.

## Step 2: 현황 스캔

프로젝트 파일 목록을 수집하되, 시스템/캐시/엔진 폴더는 제외한다. `--full`은 Task Schedule로 주기 실행될 수 있으므로, 전체 프로젝트를 매번 장황하게 재요약하지 말고 **새로 생기거나 변경된 source 후보**를 우선 탐지한다.

```bash
find <project-path> -type f \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/.tower/*' \
  -not -path '*/.pi/*' \
  -not -path '*/.runtime-box/*' \
  | head -300
```

`.project/decisions/`와 `.project/progress.md`는 숨김 폴더 안에 있지만 프로젝트 운영 기억이므로 읽을 수 있다. 단, `.tower/`와 `.pi/`는 기본적으로 wiki source가 아니라 시스템/엔진 상태로 취급한다.

### 새/변경 자료 탐지 계약 (`--full`)

`--full`은 다음 순서로 후보를 찾는다.

1. `.wiki/log.md`에서 마지막 `wiki-compile` 실행 시각을 읽는다. 없으면 최초 실행으로 간주한다.
2. 마지막 실행 이후 `mtime`이 바뀐 파일을 우선 후보로 잡는다.
3. `.wiki/index.md`의 source map과 `.wiki/pages/*` frontmatter의 `sources:`를 참고해 이미 반영된 source인지 본다.
4. 새 파일 또는 변경 파일 중 system/engine/cache 폴더는 제외한다.
5. 후보가 많으면 중요도 순으로 제한한다: decisions/records/docs/sources/research/reports/final/output 우선, 임시/빌드/대용량 바이너리는 요약 후보로만 둔다.
6. 대량 변경이 감지되면 모든 파일을 처리하지 말고 batch 계획을 `.wiki/log.md`에 남기고 우선순위 높은 일부만 반영한다.

Task Schedule로 실행되는 경우에도 이 계약을 따른다. 즉, 스케줄은 “언제 돌릴지”만 맡고, `wiki-compile --full`은 “무엇이 새롭고 무엇을 `.wiki`에 반영할지”를 스스로 판단한다.

파일을 다음 성격으로 분류한다.

| 성격 | 판별 기준 | 예시 |
|---|---|---|
| raw source | 외부에서 받은 원본, 업로드, 데이터, PDF, 웹클립 | sources/, research raw, .pdf, .xlsx, .docx |
| authored artifact | 사람이/AI가 만든 설명·산출물 | docs/, reports/, final/, output/ |
| record/decision | 작업 로그, 결정, 약속, 사고 기록 | records/, memory/, decisions/, .project/decisions/ |
| wiki derived | `.wiki/` 안의 LLM-maintained pages | .wiki/pages/*.md |
| system | Tower/Pi/runtime 상태 | .tower/, .pi/, .runtime-box/ |

## Step 3: `.wiki/index.md` 갱신

`.wiki/index.md`는 LLM과 향후 Tower Wiki UI가 먼저 읽는 진입점이다.

권장 구조:

```markdown
# .wiki Index

> Last updated: YYYY-MM-DD HH:MM

## Project summary
<AGENTS.md/SOUL.md/README.md 기반 1-3문장>

## Core pages
- [Topic title](pages/topic.md) — 한 줄 설명

## Source map
- Raw sources: 주요 위치와 성격
- Records/decisions: 주요 위치와 성격
- Authored artifacts: 주요 위치와 성격

## Open questions / gaps
- 아직 page가 없지만 반복 등장하는 주제

## Recent wiki activity
- YYYY-MM-DD: ingest/query/lint 요약
```

주의:

- `wiki/INDEX.md`가 아니라 `.wiki/index.md`를 갱신한다.
- 기존 `wiki/INDEX.md`가 있으면 과거 visible index/export 후보로 참고만 한다.
- index는 모든 파일을 장황하게 나열하는 inventory가 아니라, 다음 LLM이 어디를 봐야 하는지 알려주는 지도다.
- `.wiki` 내부 page 참조는 backtick 경로만 쓰지 말고 클릭 가능한 Markdown 링크를 기본으로 한다. 예: `[Topic title](pages/topic.md)`.
- 경로 자체도 보여줘야 하면 링크 뒤 보조 정보로 둔다. 예: `[Topic title](pages/topic.md) — \`pages/topic.md\` — 한 줄 설명`.
- `.wiki/index.md`에서 `.wiki/pages/foo.md`를 가리킬 때는 `pages/foo.md`를 쓴다. `.wiki/pages/*.md`끼리 서로 참조할 때는 같은 폴더 기준 `./other-page.md`를 쓴다.

## Step 4: page 생성/갱신

`--ingest` 또는 `--full`에서 필요한 경우 `.wiki/pages/<topic>.md`를 만든다. `--full`에서는 새/변경 자료 후보를 관련 page에 반영하고, 이미 충분히 반영된 자료는 중복 요약하지 않는다.

Page convention:

```markdown
---
type: concept | map | synthesis | note
status: current | draft | superseded
updated: YYYY-MM-DD
sources:
  - path/or/url
---

# Title

## Summary

## Key points

## Sources

## Related

## Open questions
```

원칙:

- source별 요약 파일을 무조건 대량 생성하지 않는다.
- 반복적으로 의미 있는 주제, 개념, 구조, 결정 해석을 page로 만든다.
- 기존 page와 연결되면 새 파일보다 기존 page 갱신을 우선한다.
- 중요한 claim은 page 내부 Sources로 추적한다. 별도 `claims.jsonl`은 기본 생성하지 않는다.

## Step 5: `.wiki/log.md` 기록

작업 후 `.wiki/log.md`에 시간순 기록을 남긴다.

형식:

```markdown
## [YYYY-MM-DD] ingest | <source or topic>

- Read: <paths>
- Updated: <wiki pages>
- Notes: <짧은 요약>
- Open questions: <있으면>
```

`--lint`도 초기에는 별도 `lint/` 폴더를 만들지 않고 log에 결과를 남긴다.

`--full`로 자동 탐지한 자료를 처리한 경우에는 다음도 기록한다.

```markdown
## [YYYY-MM-DD] full | scheduled or manual scan

- Changed candidates: N
- Ingested/updated: <paths>
- Skipped: <paths and reasons>
- Updated pages: <wiki pages>
- Next batch: <있으면>
```

이 기록이 다음 `--full` 실행의 기준점이 된다.

## Step 6: lint

`--lint`는 다음을 점검한다.

1. index에 있지만 없는 page
2. page는 있지만 index에 없는 page
3. page의 source path가 깨진 경우
4. `status: current`인데 superseded decision을 근거로 하는 경우
5. 같은 주제를 다루는 중복 page
6. 중요한 단정인데 Sources가 비어 있는 경우
7. 오래된 open question

반복적으로 lint 리포트가 필요해질 때만 사용자에게 `lint.md` 또는 `.wiki/lint/` 도입을 제안한다.

## Step 7: export

`--export`는 `.wiki` 정본을 사람이 보기 쉬운 snapshot으로 내보낼 때만 사용한다.

후보 위치:

```text
wiki/                 # 프로젝트에 visible wiki가 필요한 경우
final/wiki-export/    # 공유 가능한 산출물로 내보낼 경우
```

주의:

- export는 `.wiki`의 대체 정본이 아니다.
- export 파일을 만들거나 덮어쓸 때는 사용자에게 범위를 설명한다.

## 기존 프로젝트별 매핑 가이드

이미 잘 정리된 프로젝트는 물리적 구조를 바꾸지 않는다. `.wiki/index.md`에서 기존 구조를 source map으로 설명한다.

예:

```text
sources/ 또는 pdfs/       → raw source
research/                → raw + analysis 혼합 source
records/ 또는 memory/     → record/ledger source
decisions/ 또는 .project/decisions/ → decision source
docs/                    → authored artifact / reusable explanation
final/ 또는 output/       → deliverable source
wiki/                    → visible export or legacy index
.wiki/                   → distilled wiki source of derived pages
```

## 출력

실행 후 사용자에게 다음을 짧게 보고한다.

```text
📚 wiki-compile 완료: <project>

변경사항:
- .wiki/index.md 갱신
- .wiki/pages/<topic>.md 생성/수정 N건
- .wiki/log.md 기록 추가

주의/제안:
- source가 없는 page N건
- 반복 등장하지만 page가 없는 주제 N건
- export가 필요하면 /wiki-compile --export 사용
```

수정한 파일은 반드시 workspace 절대경로로 안내한다.

## Task Schedule 연계

`wiki-compile`은 자체적으로 예약을 만들지 않는다. 예약은 Tower Task Schedule이 담당한다.

권장 예약 예:

```text
매일 또는 매주: /wiki-compile --full
```

스케줄 실행 시 기대 동작:

1. 새/변경 자료 자동 탐지
2. 관련 `.wiki/pages/` 갱신
3. `.wiki/index.md` 갱신
4. `.wiki/log.md` 기록 추가
5. 대량 변경이면 일부만 처리하고 next batch를 남김

이렇게 준비된 `.wiki`는 이후 세션/작업 시작 시 `.wiki/index.md`와 관련 page만 읽어 selective context injection에 사용할 수 있다.
