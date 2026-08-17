---
name: frontend-design
description: >
  프로덕션급 프론트엔드 UI 생성·개선 — 독창적 디자인 + 코드 + AI 티 제거 lint.
  50 스타일, 97 팔레트, 57 폰트 페어링 참조 DB와 vendored impeccable detector를 내장.
  Trigger: "UI 만들어", "웹 컴포넌트", "랜딩 페이지", "대시보드", "frontend", "build a page",
  "web component", "디자인 구현", "AI 티 제거", "디자인 감사", "마지막 다듬기", "polish UI",
  "audit UI", "critique UI", "밋밋한 UI 과감하게", "과한 UI 차분하게".
  NOT for: DESIGN.md 생성·브랜드 시스템 문서화 → design-md. 디자인 탐색/아키텍처 선택 → design-explore.
version: 2.0.0
argument-hint: "[craft|audit|critique|polish|bolder|quieter|distill|harden|typeset|layout|colorize|animate|clarify|adapt|optimize] [target]"
allowed-tools:
  - Bash(node /workspace/.tower/skills/frontend-design/scripts/design-lint/bin/cli.js *)
---

# Frontend Design — distinctive UI + AI-slop removal

프로덕션급 프론트엔드 인터페이스를 만들고, 마지막에는 **AI가 만든 티**가 나는 패턴을 자동/수동으로 제거한다. 2026-06-04에 `pbakaus/impeccable`의 핵심 교훈과 deterministic detector를 흡수했다. 외부 `npx impeccable` 호출에 의존하지 말고 이 스킬의 vendored detector를 사용한다.

## Command routing

인자 첫 단어가 아래 명령이면 해당 모드로 실행한다. 없으면 `craft`로 간주한다.

| Command | 목적 | 핵심 산출 |
|---|---|---|
| `craft [target]` | 새 UI/페이지/컴포넌트 구현 | 코드 + lint 결과 |
| `audit [target]` | 기술 품질 점검 | a11y, perf, responsive, overflow, contrast |
| `critique [target]` | UX/시각 디자인 리뷰 | hierarchy, clarity, emotional fit |
| `polish [target]` | 출시 전 마지막 다듬기 | AI-slop 제거 + 정밀 보정 |
| `bolder [target]` | 안전하고 밋밋한 디자인을 과감하게 | 더 강한 hierarchy, scale, color commitment |
| `quieter [target]` | 과한 디자인을 차분하게 | noise, motion, color, density 감소 |
| `distill [target]` | 군더더기 제거 | 카드/컨테이너/장식/문구 축소 |
| `harden [target]` | 프로덕션 하드닝 | empty/error/loading/i18n/text overflow/edge cases |
| `typeset [target]` | 타이포그래피 개선 | font, scale, line-height, tracking |
| `layout [target]` | 레이아웃·간격 개선 | rhythm, composition, responsiveness |
| `colorize [target]` | 전략적 색상 추가 | OKLCH palette, contrast-safe roles |
| `animate [target]` | 목적 있는 motion 추가 | transform/opacity 중심, reduced motion |
| `clarify [target]` | UX copy 개선 | labels, errors, empty states, CTA |
| `adapt [target]` | 디바이스/화면 대응 | responsive, input methods, safe areas |
| `optimize [target]` | UI 성능 개선 | layout thrash, image, JS/render cost |

❌ `/impeccable pin`류 top-level shortcut 생성 금지. Tower의 slash namespace를 오염시키지 않는다. 필요하면 `/frontend-design polish`처럼 이 스킬 내부 subcommand로만 쓴다.

## Operating flow

### 1. Context first

코드 작성 전 최소한 다음을 확인한다.

- 프로젝트의 기존 `DESIGN.md`, `AGENTS.md`, `CLAUDE.md`, 대표 CSS/theme/component가 있으면 읽는다.
- 기존 디자인 시스템이 있으면 보존한다. 단, 명백한 AI-slop이나 품질 문제는 개선한다.
- 새 프로젝트라면 `design-md init` 또는 간단한 디자인 방향 질문을 권한다. 그래도 사용자가 바로 제작을 원하면 이 스킬의 reference DB에서 방향을 정해 진행한다.

### 2. Register 판단

작업 표면을 둘 중 하나로 분류한다.

- **Brand register**: landing, marketing, campaign, long-form, portfolio. 디자인 자체가 제품이다. 더 강한 관점, 기억나는 visual move, Committed/Full palette/Drenched 색 전략도 허용.
- **Product register**: app UI, dashboard, admin, tool, settings, form. 디자인은 작업을 돕는다. 정보 밀도, 가독성, 상태 표현, 흐름 명료성이 우선.

카테고리만 보고 색/톤을 고르지 않는다. “finance → navy/gold”, “AI tool → purple gradient”, “developer tool → dark terminal” 같은 1차 반사와, “그걸 피하려고 beige editorial”로 가는 2차 반사를 모두 경계한다.

### 3. Design commitment

구현 전 내부적으로 다음 네 가지를 고정한다.

1. **Scene sentence**: 누가, 어디서, 어떤 조명/기분에서 쓰는가. 이 문장이 light/dark와 density를 결정해야 한다.
2. **Color strategy**: Restrained / Committed / Full palette / Drenched 중 하나.
3. **Typography stance**: display/body/mono의 역할, line length, hierarchy ratio.
4. **One memorable move**: layout, texture, motion, content structure, interaction 중 하나. 장식이 아니라 맥락에서 나와야 한다.

## Hard anti-slop rules

아래는 생성 전부터 금지한다. 발견하면 고친다.

### Color

- 보라→파랑 generic gradient, cyan-on-dark, dark glow를 기본값으로 쓰지 않는다.
- cream/beige/off-white도 이제 안전한 AI 취향이다. 쓸 거면 브랜드 이유가 있어야 한다.
- `#000`, `#fff`, 무채색 gray만 쓰지 말고 hue-tinted neutral을 쓴다.
- gradient text는 금지. 의미 없는 장식이다.
- gray text on colored background 금지. 배경 hue의 더 어두운 shade 또는 충분한 contrast의 ink를 쓴다.
- body text contrast는 WCAG AA 4.5:1 이상, 큰 글자는 3:1 이상을 목표로 한다.

### Typography

- Inter, Roboto, Arial, system default, Space Grotesk, Plus Jakarta Sans, Geist, Fraunces 등 과포화 폰트는 기본 선택으로 쓰지 않는다. 기존 브랜드가 이미 쓰면 보존 가능하되 hierarchy로 구제한다.
- font-family는 최대 3개. 비슷한 sans끼리 억지 pairing하지 않는다.
- body line length는 65–75ch.
- hierarchy는 scale + weight contrast로 만든다. 단계 비율 1.25 이상을 기본으로 본다.
- hero/display heading의 `clamp()` max는 약 `6rem` 이하. 긴 문장을 128px 이상으로 키우지 않는다.
- display letter-spacing은 `-0.04em`보다 더 조이지 않는다.
- all-caps body copy 금지. uppercase는 짧은 label/eyebrow에만.
- `text-wrap: balance`를 h1–h3에, `text-wrap: pretty`를 긴 문단에 고려한다.

### Layout

- 카드가 기본 답이 아니다. spacing, typography, divider, grouping으로 해결할 수 있으면 card를 쓰지 않는다.
- nested cards는 금지.
- 같은 padding/spacing을 모든 곳에 반복하지 않는다. 관련 요소는 촘촘하게, 섹션 전환은 넉넉하게.
- viewport edge에 본문이 붙지 않게 최소 16px, 가능하면 24–32px horizontal padding.
- cramped padding, overflow, skipped heading levels를 출시 전 고친다.

### Motion

- bounce/elastic easing 금지. dated하고 AI 티가 난다.
- width/height/padding/margin 등 layout property animation 금지. transform/opacity 중심.
- scroll-fade-rise를 모든 섹션에 반복하지 않는다. 한 번의 signature moment 또는 기능적 micro-interaction이면 충분하다.
- reduced motion 대응을 고려한다.

### Copy

- em dash(`—`, 과도한 `--`) 남발 금지.
- “streamline, empower, supercharge, world-class, enterprise-grade, next-generation, cutting-edge” 같은 generic SaaS buzzword를 구체적 동사/명사로 바꾼다.
- “Not X. Just Y.”, “Not a feature. A platform.” 같은 aphoristic cadence를 반복하지 않는다.
- 제목을 본문 첫 줄에서 다시 설명하지 않는다. 모든 단어가 일을 해야 한다.

## Vendored design-lint

이 스킬은 `pbakaus/impeccable` detector subset을 vendored copy로 포함한다.

```bash
node /workspace/.tower/skills/frontend-design/scripts/design-lint/bin/cli.js detect <target> --json
```

사용 원칙:

- HTML 파일, 정적 산출물, 소스 디렉토리 등 concrete target이 있으면 `polish`, `audit`, `craft` 완료 전에 실행한다.
- `--fast --json`은 빠른 텍스트/정적 검사에 적합하다.
- URL/browser scan은 optional browser dependency가 필요할 수 있으므로, Tower에서는 정적 파일/디렉토리 scan을 기본으로 한다.
- High-confidence finding은 직접 수정한다. Advisory/provider-gated finding은 맥락을 보고 판단한다.
- detector가 못 잡는 것도 많다. 최종 판단은 위 hard rules와 register 기준으로 한다.

대표 rule family:

- AI slop: side-tab border, overused font, single font, flat type hierarchy, gradient text, AI color palette, cream palette, nested cards, monotonous spacing, bounce easing, dark glow, icon-tile stack, italic-serif display, hero eyebrow chip, numbered section markers, em-dash overuse, marketing buzzword, aphoristic cadence, oversized H1, crushed tracking.
- Quality: low contrast, gray-on-color, layout transition, line length, cramped padding, viewport edge, tight leading, skipped heading, justified text, tiny text, all-caps body, wide tracking, text overflow, clipped positioned child.

## Design Reference DB

필요할 때 `references/`를 읽어서 구체적 선택지를 가져온다.

| 파일 | 내용 |
|------|------|
| `references/ui-data/styles.csv` | 50개 디자인 스타일 정의 |
| `references/ui-data/colors.csv` | 97개 컬러 팔레트 |
| `references/ui-data/typography.csv` | 57개 폰트 페어링 |
| `references/ui-data/charts.csv` | 25개 차트 타입 가이드 |
| `references/ui-data/web-interface.csv` | 웹 인터페이스 패턴 |
| `references/ui-data/landing.csv` | 랜딩 페이지 패턴 |
| `references/ui-data/products.csv` | 제품별 UI 추천 |
| `references/ui-data/stacks/` | React, Vue, Svelte 등 9개 스택별 가이드 |
| `references/ui-scripts/search.py` | 데이터 검색 유틸리티 |

## Definition of done

작업 완료 전 확인한다.

1. register와 scene sentence에 맞는 theme/density인가?
2. category reflex와 second-order slop을 피했는가?
3. typography가 읽히고 hierarchy가 분명한가?
4. cards, gradients, icons, motion이 맥락 없이 반복되지 않는가?
5. empty/loading/error/edge states가 필요한 곳에 있는가?
6. mobile/responsive와 overflow가 망가지지 않는가?
7. 가능한 경우 vendored design-lint를 돌렸고, 주요 finding을 수정했는가?
8. 사용자가 열 수 있는 파일을 만들거나 수정했다면 Tower 절대경로를 응답에 적었는가?

## Attribution

`design-lint/`는 `pbakaus/impeccable`의 Apache-2.0 detector subset을 vendored copy로 흡수했다. 자세한 출처는 `scripts/design-lint/NOTICE.md`를 보라.
