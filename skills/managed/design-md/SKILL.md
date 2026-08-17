---
name: design-md
description: >
  DESIGN.md 디자인 시스템 문서 생성/적용. 55개 브랜드 프리셋 제공 + 웹사이트 URL로 새 DESIGN.md 생성.
  Tower 프로젝트 컨텍스트(SOUL/AGENTS/progress)와 impeccable anti-slop 규칙을 흡수한 init/document 흐름 포함.
  Trigger: "디자인 시스템", "design md", "DESIGN.md", "디자인 적용", "브랜드 스타일",
  "design system", "look and feel", "UI 스타일 가이드", "디자인 시스템 초기화", "AI 티 금지 규칙".
argument-hint: "[init | use <brand> | create <url> | list | preview]"
version: 1.1.0
---

# Design MD

프로젝트에 DESIGN.md 디자인 시스템 문서를 적용하거나, 웹사이트를 분석해서 새로 생성한다.

DESIGN.md는 Google Stitch가 제안한 컨셉으로, 프로젝트 루트에 놓으면 AI 코딩 에이전트가 해당 브랜드/스타일로 일관된 UI를 생성할 수 있게 해주는 디자인 시스템 명세서다.

## Commands

| Command | Description |
|---|---|
| `/design-md init` | Tower 프로젝트 컨텍스트를 읽어 PRODUCT.md 강제 없이 DESIGN.md 초안/보강 |
| `/design-md list` | 사용 가능한 55개 브랜드 프리셋 목록 |
| `/design-md use <brand>` | 브랜드 DESIGN.md를 가져와 프로젝트 루트에 배치 |
| `/design-md create <url>` | 웹사이트 URL을 분석해서 새 DESIGN.md 생성 |
| `/design-md preview` | 현재 프로젝트의 DESIGN.md 요약 표시 |

## Execution Flow

### Parse Command

`$ARGUMENTS`에서 커맨드를 파싱한다:
- `init` → Tower 프로젝트 컨텍스트 기반 DESIGN.md 초기화/보강
- `list` → 브랜드 목록 표시
- `use <brand>` → 프리셋 적용
- `create <url>` → URL 분석 후 생성
- `preview` → 현재 DESIGN.md 요약
- 인자 없음 → list 실행

---

### Command: `init`

Tower 프로젝트 안에서 DESIGN.md를 새로 만들거나 보강한다. upstream impeccable의 `init/document` 정신을 흡수하되, PRODUCT.md를 강제하지 않는다. Tower의 프로젝트 기억과 운영 문서를 먼저 읽는다.

#### Step 1: 프로젝트 컨텍스트 수집

가능한 파일을 순서대로 확인한다. 없는 파일은 건너뛴다.

```text
./DESIGN.md
./SOUL.md
./AGENTS.md
./CLAUDE.md
./.project/progress.md
./.project/decisions/*.md
./src/**/theme.*
./src/**/*.css
./app/**/*.css
```

읽을 때 추출할 것:

- **정체성/북극성**: 누구를 위한 제품인가, 어떤 감정과 태도를 가져야 하는가
- **Audience**: 내부 도구, 고객용, 임원용, 소비자용 등
- **Anti-references**: 사용자가 싫어한다고 한 것, 피해야 하는 업계 클리셰
- **Existing tokens**: 색, 폰트, radius, shadow, spacing, 컴포넌트 패턴
- **AI-slop risk**: Inter/default font, 보라·파랑 gradient, nested cards, icon tile stack, cream/beige 안전 취향, generic SaaS copy 등

#### Step 2: 모드 결정

- 기존 `DESIGN.md`가 없으면 **seed mode**: 최소 디자인 시스템 초안 작성.
- 기존 `DESIGN.md`가 있으면 **augment mode**: 기존 값을 보존하고 `Do/Don't`, anti-slop, agent guide를 보강.
- 실제 CSS/tokens가 풍부하면 **scan mode**: 추출값 중심으로 구체화.

기존 DESIGN.md를 덮어써야 할 때는 사용자에게 확인한다. 단순 보강은 targeted edit로 진행한다.

#### Step 3: impeccable anti-slop을 DESIGN.md에 박기

`Do's and Don'ts` 또는 `Agent Prompt Guide`에 프로젝트 말투로 구체화한다. 일반론으로 두지 말고 프로젝트의 anti-reference와 결합한다.

필수 Don't 후보:

- Generic AI SaaS look: purple-blue gradient, cyan-on-dark glow, glass card, gradient text
- Overused typography: Inter/Roboto/system default를 이유 없이 기본값으로 쓰기
- Card monoculture: card grid, nested card, icon tile above every heading
- Second-order slop: beige editorial, oversized italic serif, numbered section markers, repeated eyebrow chips를 무비판적으로 쓰기
- Copy slop: “streamline/empower/supercharge”, em dash 남발, “Not X. Just Y.” 반복
- Quality failures: low contrast, gray-on-color, cramped padding, overflow, skipped heading, tiny body text

#### Step 4: DESIGN.md 구조

새로 작성할 때는 기존 9개 섹션 구조를 유지한다. 다만 Tower 프로젝트에서는 8번과 9번을 특히 강하게 쓴다.

```markdown
## 8. Do's and Don'ts

### Do
- [프로젝트 맥락에 맞는 구체적 규칙]

### Don't
- [AI 티/브랜드 위반/품질 실패를 이름으로 금지]

## 9. Agent Prompt Guide

When building UI for this project:
- [색/타입/컴포넌트/레이아웃 규칙]
- [AI-slop lint에서 걸리면 반드시 고칠 항목]
```

#### Step 5: frontend-design과 연결

DESIGN.md 작성 후 사용자에게 다음을 안내한다.

```text
이제 UI 생성/수정은 /frontend-design craft|polish|audit 로 진행하면 이 DESIGN.md와 vendored AI-slop detector를 같이 사용합니다.
```

---

### Command: `list`

GitHub API로 브랜드 목록을 조회한다:

```bash
gh api repos/VoltAgent/awesome-design-md/contents/design-md --jq '.[].name' | sort
```

결과를 카테고리별로 정리해서 보여준다:

- **Tech/SaaS**: airbnb, airtable, cursor, figma, framer, intercom, linear.app, miro, notion, posthog, raycast, vercel, webflow, zapier
- **AI/ML**: claude, cohere, elevenlabs, minimax, mistral.ai, nvidia, ollama, opencode.ai, replicate, together.ai, voltagent, x.ai
- **Design**: apple, bmw, cal, clay, lovable, mintlify, pinterest, sanity, spotify, warp
- **Fintech/Crypto**: coinbase, kraken, revolut, stripe, superhuman, wise
- **Enterprise**: clickhouse, composio, expo, hashicorp, ibm, mongodb, resend, runwayml, sentry, spacex, supabase, uber

---

### Command: `use <brand>`

1. **브랜드 확인** — 입력된 이름이 유효한지 확인:
   ```bash
   gh api repos/VoltAgent/awesome-design-md/contents/design-md/$BRAND --jq '.[].name' 2>/dev/null
   ```
   없으면 유사한 이름 제안.

2. **DESIGN.md 다운로드**:
   ```bash
   gh api repos/VoltAgent/awesome-design-md/contents/design-md/$BRAND/DESIGN.md --jq '.content' | base64 -d
   ```

3. **프로젝트 루트에 저장** — 현재 작업 디렉토리(또는 사용자가 지정한 경로)에 `DESIGN.md`로 저장한다.

4. **기존 파일 확인** — 이미 DESIGN.md가 있으면 사용자에게 덮어쓸지 물어본다.

5. **요약 표시** — 적용된 디자인 시스템의 핵심 요소를 간단히 보여준다:
   - 브랜드명
   - 주요 색상 (Primary, Accent)
   - 폰트
   - 전체 분위기 한 줄 요약

---

### Command: `create <url>`

웹사이트를 분석해서 DESIGN.md를 새로 생성한다.

#### Step 1: 웹사이트 크롤링

먼저 WebFetch로 정적 HTML을 읽고, JS 렌더링/시각 확인이 필요하면 Runtime Box Playwright/web-capture로 대체한다.

```
WebFetch <url>
```

또는 Runtime Box Playwright로 페이지를 열어 DOM/CSS/screenshot을 수집한다.

**수집 대상:**
- HTML 구조 (시맨틱 태그, 컴포넌트 패턴)
- CSS 변수 (custom properties: `--color-*`, `--font-*`, `--spacing-*`)
- 인라인/외부 스타일시트의 핵심 규칙
- 메타 정보 (title, description, favicon, theme-color)
- 이미지/SVG 패턴

가능하면 CSS 파일도 직접 가져온다:
```
WebFetch <css-url>
```

#### Step 2: 디자인 토큰 추출

크롤링 결과에서 다음을 체계적으로 추출한다:

**색상 체계:**
- CSS 변수에서 색상값 추출 (`--color-*`, `--bg-*`, `--text-*`)
- 인라인 스타일과 클래스에서 반복되는 색상 패턴 식별
- Primary / Secondary / Accent / Neutral / Surface / Border / Shadow 분류

**타이포그래피:**
- font-family 선언 (웹폰트 URL 포함)
- 크기별 hierarchy (h1~h6, body, caption, code)
- weight, line-height, letter-spacing 패턴

**컴포넌트:**
- 버튼 스타일 (primary, secondary, ghost, 크기 변형)
- 카드/컨테이너 패턴 (padding, border-radius, shadow)
- 입력 필드 스타일
- 네비게이션 패턴
- 배지/태그/칩

**레이아웃:**
- max-width, 그리드/flex 패턴
- spacing scale (padding/margin 반복 값)
- 반응형 breakpoint

**기타:**
- border-radius scale
- shadow 레이어
- transition/animation 패턴
- 아이콘 시스템

#### Step 3: DESIGN.md 작성

아래 **정확한 섹션 구조**를 따라 DESIGN.md를 작성한다. 이것은 awesome-design-md 레포의 표준 포맷이다.

```markdown
# Design System: [Brand Name]

## 1. Visual Theme & Atmosphere
[브랜드의 전체적 분위기, 디자인 철학, 핵심 특징을 서술형으로 설명.
단순 나열이 아니라 "왜 이렇게 보이는지"를 설명해야 한다.
마지막에 **Key Characteristics:** 불릿 리스트로 핵심 포인트 정리.]

## 2. Color Palette & Roles
[### Primary / ### Brand & Dark / ### Accent Colors / ### Interactive /
### Neutral Scale / ### Surface & Borders / ### Shadow Colors
각 색상에 역할 설명 포함. HEX + CSS 변수명 병기.]

## 3. Typography Rules
[### Font Family / ### Hierarchy (표 형식) / ### Principles
테이블 컬럼: Role | Font | Size | Weight | Line Height | Letter Spacing | Notes]

## 4. Component Styles
[### Buttons / ### Cards / ### Inputs / ### Navigation / ### Badges & Tags
각 컴포넌트의 CSS 속성을 구체적으로 기술]

## 5. Layout & Spacing
[### Container / ### Grid System / ### Spacing Scale
구체적 px 값과 패턴]

## 6. Elevation & Shadows
[박스 섀도우 레이어 상세, 용도별 분류]

## 7. Responsive Behavior
[브레이크포인트, 모바일 대응 패턴]

## 8. Do's and Don'ts
[### Do / ### Don't
이 디자인 시스템을 사용할 때의 규칙]

## 9. Agent Prompt Guide
[AI 에이전트가 이 디자인을 구현할 때 참고할 구체적 지침.
"이 스타일로 만들어줘"라고 했을 때 에이전트가 따를 규칙.]
```

#### Step 4: 저장 및 확인

1. `DESIGN.md`를 프로젝트 루트에 저장
2. 핵심 요약을 사용자에게 표시
3. preview.html도 함께 생성할지 물어보기 (선택사항)

---

### Command: `preview`

현재 프로젝트의 DESIGN.md를 읽고 요약을 표시한다:
- 브랜드명
- 주요 색상 팔레트 (시각화)
- 타이포그래피 스택
- 핵심 컴포넌트 스타일
- 전체 분위기 한 줄

---

## Rules

- DESIGN.md는 항상 **프로젝트 루트**에 배치한다 (Google Stitch 컨벤션)
- `create` 시 추측하지 말 것 — 실제 크롤링 데이터에서 추출한 값만 사용
- 색상값은 반드시 HEX로 표기하고, rgba가 필요한 경우 (shadow 등) 별도 표기
- CSS 변수명이 확인되면 반드시 병기 (예: `--hds-color-heading-solid`)
- 타이포그래피 hierarchy는 반드시 **표 형식**으로 작성
- `use` 시 기존 DESIGN.md가 있으면 반드시 확인 후 덮어쓰기
- 9개 섹션 구조를 항상 유지할 것 — 정보가 부족한 섹션도 최선의 추론으로 채움

## Source

- **프리셋 레포**: https://github.com/VoltAgent/awesome-design-md
- **컨셉 원본**: Google Stitch — "DESIGN.md를 프로젝트 루트에 놓으면 AI가 브랜드 스타일로 UI 생성"
