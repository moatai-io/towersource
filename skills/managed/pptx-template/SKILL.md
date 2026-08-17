---
name: pptx-template
description: |
  Brand-template-driven PPTX generator. Take a customer brand .pptx (or default seed) +
  YAML data → produce native editable .pptx with placeholder-filled slides. YAML is the
  intermediate format: data is reviewable, reproducible, and easy to vision-review.
  Companion to image-slide-gen (which generates image-based slides with OpenAI gpt-image-2) and pptx-edit
  (which edits arbitrary existing files).
  Use when: "도입 제안서 PPTX", "고객 브랜드 .pptx 채워줘", "YAML 로 PPTX 만들어",
  "templated proposal", "fill brand template", "/pptx-template", "Tower 제안서 PPTX",
  "회사 소개 PPTX", "프로젝트 보고 PPTX".
  NOT for: 0에서 새 디자인 (→ /image-slide-gen), 임의 .pptx 의 부분 편집 (→ /pptx-edit).
argument-hint: "[topic or path/to/data.yaml]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
requires:
  cli: [uv, libreoffice]
  python: [pptx, yaml, PIL]
  network: none
---

# pptx-template — Templated PPTX from YAML data

브랜드 .pptx 템플릿 (또는 default 시드) + YAML 데이터 → 채워진 native .pptx.

## 워크플로

```
사용자 의도            (자연어)
    ↓
AI: YAML draft 작성    (data.yaml)
    ↓
사용자 확인/수정       (YAML 직접 편집 가능)
    ↓
build_from_yaml.py    (template + data → output.pptx)
    ↓
render_png.py         (PNG 검증)  ← pptx-edit 의 스크립트 재사용
    ↓
사용자 보고            (PNG + .pptx 경로)
```

## Step 1 — 입력 결정

사용자가 다음 중 하나로 들어옴:
1. **주제만** ("Tower 도입 제안서") → AI 가 default 콘텐츠로 yaml draft 작성
2. **주제 + 핵심 정보** ("회사명 ABC, 가격 X") → yaml 에 채움
3. **이미 작성한 yaml 경로** → 검증 후 빌드로 직행
4. **사용자 .pptx 템플릿 + 주제** (v0.5+) → analyze_template 으로 톤 추출 → yaml 에 적용

### 사용자 .pptx 분석 (v0.5+)

#### 1차: Static parsing (스크립트)
사용자가 본인 회사 브랜드 .pptx 를 주면:
```bash
uv run --script /workspace/.tower/skills/pptx-template/scripts/analyze_template.py <brand.pptx>
```
출력에 yaml `theme:` 섹션이 그대로 나옴 — 복사해 data.yaml 에 붙여넣기.

추출되는 것:
- color scheme (theme.xml clrScheme): dk1/lt1/accent1~6
- font scheme: Latin / 한글 (East-Asian) 폰트
- 슬라이드에서 가장 많이 쓴 색 (heuristic — 진짜 brand color)
- layout 카탈로그 (placeholder 위치, 정보용)

매핑 휴리스틱:
- `dk1`/`dk2` → `primary`
- `accent1` → `accent`, `accent2` → `subtle`
- `lt2` → `panel`
- `minorFont_ea` (한글) 우선 → `font`

#### 2차: Vision 보강 (현재 세션의 Claude 가 직접)

⚠️ 외부 Vision API 호출 X. **현재 세션의 Claude 가 Read 도구로 PNG 를 직접 본다.**

워크플로:
1. `render_png.py` 로 사용자 .pptx 의 슬라이드 1~3장만 PNG 렌더
2. Read 도구로 PNG 들 받아서 멀티모달 평가:
   - 헤더/푸터 chrome 패턴 (가로선 위치, 회사명 표기 위치)
   - 강조 색의 실제 사용처 (accent 가 어디에 어떻게 쓰이는가)
   - bullet 마커 모양 (• ▶ ● ◆ ■ 어느 것?)
   - 챕터/섹션 표기 패턴
3. static parsing 으로 못 잡은 부분을 yaml 에 보강 (`bullet_char`, `confidential` 등)
4. 다듬어진 yaml `theme:` + meta 자동 생성

### 브랜드 템플릿 처리
- 사용자가 본인 .pptx 제시 → analyze_template 으로 톤만 추출 (color/font yaml)
- 미제시 → default v0.4 시드 (Deep navy + Champagne gold)

## Step 2 — YAML draft 작성

**중요**: YAML 을 작성하기 전에 [reference.md](reference.md) 의 **schema 와 layout 카탈로그** 를 먼저 읽는다. 어떤 layout 이 있는지 모르면 잘못된 필드를 채운다.

산출물 폴더:
- **사용자가 명시한 위치 우선**. 모호하면 묻는다 — 추측 금지.
- 사용자-visible 산출물을 `/tmp` 또는 특정 프로젝트명이 박힌 고정 경로에 쓰지 않는다.
- 현재 프로젝트에 visible scaffold가 있으면 프로젝트 `AGENTS.md`를 우선 따른다.
  - 초안 YAML, 렌더 검토 PNG, 반복 빌드 산출물 → `work/<deck>/`
  - 공유 가능한 최종 PPTX/PDF/전달 패키지 → `final/<deck>/`
- 기존 프로젝트에 `presentations/` 같은 더 강한 덱 계약이 이미 있으면 그 계약을 따른다.
- 영구 보관 + 프로젝트 미정 → 사용자에 폴더 명시 요청
- 폴더 안 구성:
  - `data.yaml` (재빌드용 데이터 사본 — 항상 함께 둬야 재현 가능)
  - `output.pptx` (또는 `<주제>.pptx` — 최종본)
  - `slide-001.png` ~ (검증/리뷰용)
  - 진화 history 보존 시 `v2-*.pptx`, `v3-*.pptx` 등 함께 둠
- ⚠️ **가짜 프로젝트 폴더 만들지 말 것** — 코드베이스 이름(예: "tower")을 `workspace/projects/<이름>/` 으로 새로 만들면 진짜 프로젝트 목록 오염됨. `workspace/projects/` 는 사용자가 직접 만든 프로젝트만 들어가는 디렉토리.

데이터 작성 규칙:
- 회사명·금액·일자 등 사용자가 채워야 할 자리는 `[클라이언트명]` 같은 명시적 placeholder
- 한국어/영어 혼용 OK (폰트 fallback 자동)
- 줄바꿈 필요 시 YAML literal block (`|`) 또는 `<br/>`

## Step 3 — 사용자 확인

YAML draft 를 보여주고 한 번 확인을 받는다:
> "data.yaml 작성했습니다. 빌드 전에 검토하시겠어요? 아니면 바로 빌드?"

빠른 흐름을 원하면 바로 빌드. 신중한 흐름을 원하면 사용자가 yaml 직접 편집 후 빌드.

## Step 4 — Build

```bash
uv run --script /workspace/.tower/skills/pptx-template/scripts/build_from_yaml.py \
    --data path/to/data.yaml \
    --template /workspace/.tower/skills/pptx-template/templates/default-corporate.pptx \
    --out path/to/output.pptx
```

`--template` 미지정 시 default-corporate 자동 사용.

## Step 5 — Render & Verify

`pptx-edit` 의 `render_png.py` 재사용:

```bash
python3 /workspace/.tower/skills/pptx-edit/scripts/render_png.py output.pptx
```

생성된 `slide-NNN.png` 를 Read 도구로 확인. 텍스트 overflow / 폰트 깨짐 발견 시:
- yaml 수정 후 재빌드, 또는
- 직접 편집 필요 시 `/pptx-edit` 로 전환

## Step 6 — 사용자 보고

1. 빌드 슬라이드 수 + 사용 layout 별 통계
2. `output.pptx` 절대 경로
3. 검증 PNG 1~3장 (표지 + 핵심 슬라이드)
4. 다음 액션 옵션 (placeholder 채우기, 슬라이드 추가/삭제, 디자인 수정)

## Default 템플릿 빌드/재빌드

`templates/default-corporate.pptx` 를 잃거나 수정하려면:

```bash
uv run --script /workspace/.tower/skills/pptx-template/scripts/make_default_template.py
```

코드로 정의되어 있어 색상/폰트/레이아웃 조정이 git-friendly.

## Test Pack

| Type | JTBD | Purpose |
|------|------|---------|
| Primary | "Tower 도입 제안서" → 9쪽 generic 빌드 → 보고 | 핵심 워크플로 |
| Primary | 사용자 yaml 수정 후 재빌드 | YAML 라운드트립 |
| Edge | 100쪽+ 데이터 (반복 layout) | 성능 |
| Edge | layout 이름 오타 ("bulletes") | 명확한 에러 보고 |
| Regression | 한글 폰트가 □ 안 됨 | font fallback |

## v0.2 후보

- vision review loop 통합 (autorun render → vision 평가 → yaml 자동 수정)
- layouts 추가: kpi, feature_grid, timeline, pricing, image_full
- 사용자 본인 .pptx 마스터에서 layout 자동 추출 (placeholder 매핑 학습)
- offer-A4-html 의 디자인 토큰 공유 (단일 색상 시스템)
