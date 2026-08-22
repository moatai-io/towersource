---
name: html-slide
description: |
  HTML/CSS 기반 고품질 슬라이드 제작 + Chromium PDF 렌더링 스킬.
  프레임워크 없이 self-contained HTML 한 파일로 프레젠테이션, 제안서, 보고서형 슬라이드를 만들고 PDF로 출력한다.
  Use when: "html-slide", "/html-slide", "HTML 슬라이드", "HTML 발표자료", "HTML PPT",
  "슬라이드 HTML", "발표자료 HTML", "Puppeteer 슬라이드", "PDF 슬라이드", "커스텀 슬라이드",
  "프레젠테이션 HTML", "제안서 슬라이드", "디자인 좋은 발표자료".
  NOT for: OpenAI 이미지 기반 슬라이드 생성 → image-slide-gen. native PPTX 템플릿 생성 → pptx-template. 기존 PPTX 수정 → pptx-edit.
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
argument-hint: "[topic or source file path]"
---

# html-slide — HTML/CSS 슬라이드 제작

HTML/CSS 기반 고품질 슬라이드 제작 → Chromium PDF 렌더링 파이프라인. 기존 `ppt-gen`의 HTML 커스텀 모드를 독립 스킬로 분리한 것이다.

## 언제 쓰나

- 이미지 생성 비용 없이 **디자인 좋은 16:9 PDF 슬라이드**가 필요할 때
- 컨설팅 제안서, 임원 보고, 제품 소개, 내부 발표처럼 레이아웃 완성도가 중요할 때
- 표, KPI, 카드, 타임라인, 비교표처럼 **정확한 텍스트/수치**가 중요한 슬라이드
- native PPTX 편집성보다 PDF/HTML 품질이 더 중요할 때

## 경계

- AI가 각 장을 그림처럼 생성하는 방식 → `image-slide-gen`
- 브랜드 템플릿 기반 editable `.pptx` → `pptx-template`
- 기존 `.pptx` 파일 수정 → `pptx-edit`
- A4 인쇄 제안서/견적서 → `offer-A4-html`

## Execution Flow

```text
1. 입력 확인
   ├── 주제/청중/분량/톤 확인
   └── 기존 자료가 있으면 읽어서 슬라이드 목차 작성

2. 산출 폴더 생성
   └── presentations/YYYY-MM-DD_주제_html-slide/
       └── assets/  # 로고·이미지·폰트·데이터 등 HTML 보조 파일

3. index.html 작성
   ├── 16:9 slide canvas
   ├── 디자인 시스템 토큰
   ├── 슬라이드별 콘텐츠
   ├── 공유 가능한 asset 참조 (`./assets/...` 또는 inline SVG/data URI)
   └── overflow guard CSS

4. PDF 렌더링
   └── scripts/render_pdf.mjs 또는 chromium print-to-pdf

5. 시각 검증
   ├── PDF/HTML을 Read로 직접 확인
   └── 텍스트 잘림·겹침·비율 깨짐 발견 시 수정 후 재렌더
```

## 1. 슬라이드 사이즈

| 이름 | 사이즈 | 비율 | 용도 |
|---|---:|---:|---|
| 16:9 Wide 기본 | 338.67mm × 190.5mm | 16:9 | 발표자료, 제안서 |
| A4 Landscape | 297mm × 210mm | √2:1 | 인쇄 보고서, 필요 시만 |
| 4:3 Classic | 254mm × 190.5mm | 4:3 | 레거시 호환 |

기본은 항상 16:9다. A4가 필요하면 `offer-A4-html`을 우선 고려한다.

## 2. Portable asset 규칙

HTML 슬라이드는 나중에 공유 링크, Publishing, PDF export, 파일 뷰어 preview로 전달될 가능성이 높다. 따라서 생성 시점부터 공유 가능한 asset 구조를 기본값으로 삼는다.

- 산출 폴더에는 `index.html` 옆에 `assets/`를 둔다.
- 로고·사진·차트 PNG/SVG·폰트·보조 JSON/CSV 등 HTML이 참조하는 파일은 `assets/` 아래에 복사한다.
- HTML에서는 `./assets/logo.png`, `./assets/chart-1.svg` 같은 상대경로만 쓴다.
- 작은 로고·아이콘·간단 도형은 inline SVG 또는 data URI를 우선한다.
- `<img>`, `<source>`, `<link>`, CSS `url(...)`에 `file://`, `/home/...`, `~/workspace/...`, `/tmp/...`, `localhost`, `127.0.0.1`, 인증이 필요한 `/api/files/...`를 직접 넣지 않는다.
- 원본 추적이 필요하면 `data-tower-source-path="projects/<project>/sources/logo.png"` metadata를 남길 수 있지만, `src` 자체는 `./assets/...` 또는 inline이어야 한다.
- 외부 CDN font/image는 사용자가 허용했거나 공개 웹 접근이 안정적인 경우만 쓴다. 고객 전달·공유·PDF 최종본에서는 로컬 asset 또는 시스템 폰트 fallback을 우선한다.

## 3. 기본 HTML 골격

```html
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>HTML Slide Deck</title>
<link rel="stylesheet" as="style" crossorigin
  href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --font: Pretendard, 'Noto Sans KR', -apple-system, BlinkMacSystemFont, sans-serif;
    --bg: #0c0a20;
    --panel: rgba(255,255,255,.055);
    --panel-2: rgba(255,255,255,.085);
    --border: rgba(255,255,255,.11);
    --text: #f8fafc;
    --muted: rgba(248,250,252,.66);
    --accent: #e11d48;
    --purple: #a78bfa;
    --warm: #f59e0b;
    --teal: #2dd4bf;
  }
  html, body { margin: 0; padding: 0; font-family: var(--font); background: #111; }
  @page { size: 338.67mm 190.5mm; margin: 0; }
  @media print {
    html, body { margin: 0 !important; padding: 0 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .slide { margin: 0 !important; box-shadow: none !important; page-break-after: always; break-after: page; }
  }
  .slide {
    width: 338.67mm;
    height: 190.5mm;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    color: var(--text);
    background:
      radial-gradient(circle at 12% 12%, rgba(167,139,250,.26), transparent 30%),
      radial-gradient(circle at 88% 20%, rgba(45,212,191,.16), transparent 32%),
      linear-gradient(135deg, #080716 0%, var(--bg) 46%, #17112f 100%);
  }
  .slide-body { flex: 1; min-height: 0; padding: 18mm 25mm 14mm; display: flex; flex-direction: column; }
  .eyebrow { color: var(--teal); font-size: 9pt; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
  h1 { margin: 4mm 0 5mm; font-size: 30pt; line-height: 1.08; letter-spacing: -.04em; }
  h2 { margin: 0 0 4mm; font-size: 20pt; line-height: 1.18; }
  p, li { font-size: 12.5pt; line-height: 1.48; color: var(--muted); }
  .grid { display: grid; gap: 5mm; }
  .cols-2 { grid-template-columns: 1fr 1fr; }
  .cols-3 { grid-template-columns: repeat(3, 1fr); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 6mm; box-shadow: 0 20px 70px rgba(0,0,0,.2); }
  .kpi { font-size: 34pt; font-weight: 900; letter-spacing: -.05em; color: white; }
  .accent { color: var(--warm); }
  .footer { position: absolute; left: 25mm; right: 25mm; bottom: 7mm; display: flex; justify-content: space-between; color: rgba(255,255,255,.36); font-size: 8pt; }
</style>
</head>
<body>
  <section class="slide cover">
    <div class="slide-body">
      <div class="eyebrow">EXAMPLE ORG · PROPOSAL</div>
      <h1>슬라이드 제목</h1>
      <p>핵심 메시지를 한 문단으로 씁니다.</p>
    </div>
    <div class="footer"><span>Confidential</span><span>01</span></div>
  </section>
</body>
</html>
```

## 3. 스타일 프리셋

### 3.1 Dark Indigo Glass — 기본 추천

컨설팅/테크/AI 제안서에 가장 잘 맞는다.

```css
:root {
  --bg-deep: #0c0a20;
  --bg-card: rgba(255,255,255,.04);
  --border: rgba(255,255,255,.07);
  --accent: #e11d48;
  --purple: #a78bfa;
  --warm: #f59e0b;
  --teal: #2dd4bf;
}
```

사용 패턴:
- Glassmorphism 카드: `background: rgba(255,255,255,.055); backdrop-filter: blur(10px);`
- Ambient orb: radial-gradient 배경
- McKinsey 밀도: 작은 표, 얇은 라인, 2~3단 그리드

### 3.2 Clean White Corporate

금융/전통기업/보고서 톤.

```css
:root {
  --bg: #ffffff;
  --text: #111827;
  --muted: #4b5563;
  --panel: #f8fafc;
  --border: #e5e7eb;
  --accent: #2563eb;
  --navy: #1f3a68;
}
```

### 3.3 Warm Minimal

브랜드 스토리, 임원 요약, 편지형 제안.

```css
:root {
  --bg: #faf8f5;
  --text: #2d2a26;
  --muted: #766f66;
  --panel: #ffffff;
  --border: #e7e0d8;
  --accent: #c2410c;
  --warm: #f5a623;
}
```

### 3.4 High-Contrast Boardroom

숫자와 결론을 강하게 박는 이사회/투자자용.

```css
:root {
  --bg: #050505;
  --text: #ffffff;
  --muted: #a3a3a3;
  --panel: #111111;
  --border: #27272a;
  --accent: #f97316;
  --green: #22c55e;
}
```

## 4. 슬라이드 패턴

| 패턴 | 용도 | 구조 |
|---|---|---|
| cover | 표지 | eyebrow + h1 + subtitle + background orb |
| agenda | 목차 | section number + 4~6 rows |
| executive-summary | 임원 요약 | 3 KPI + 3 takeaways |
| problem-solution | 문제/해결 | 좌우 카드 비교 |
| kpi-dashboard | 수치 강조 | KPI 카드 3~5개 |
| timeline | 일정 | 가로 단계 카드 |
| comparison | 옵션 비교 | 2~3열 비교표 |
| architecture | 시스템 구조 | CSS node/edge 또는 SVG inline |
| pricing | 가격/조건 | 카드 2~3개 |
| closing | 마무리 | CTA + contact |

## 5. 렌더링

스킬 내 스크립트 사용:

```bash
node /workspace/.tower/skills/html-slide/scripts/render_pdf.mjs \
  ./index.html \
  ./slides.pdf
```

또는 Chromium 직접 사용:

```bash
chromium-browser --headless --disable-gpu --no-sandbox \
  --print-to-pdf=./slides.pdf \
  --print-to-pdf-no-header \
  file://$PWD/index.html
```

## 6. 검증 체크리스트

PDF/HTML 생성 후 반드시 시각 확인한다.

- 슬라이드 경계 밖으로 삐져나온 요소 없음
- 텍스트가 잘리거나 겹치지 않음
- 표가 너무 작지 않음
- 로고/이미지 비율이 찌그러지지 않음
- 여백과 정렬이 슬라이드 간 일관됨
- 페이지 번호/비밀등급/출처가 필요한 곳에 있음
- 색 대비가 충분함

문제가 있으면 CSS 수정 → 재렌더 → 다시 확인한다.

## 7. 산출물 위치

프로젝트 컨텍스트가 있으면:

```text
workspace/projects/<project>/presentations/YYYY-MM-DD_주제_html-slide/
├── index.html
├── slides.pdf
├── review-notes.md
└── assets/
    ├── logo.png
    ├── chart-1.svg
    └── hero.png
```

프로젝트 컨텍스트가 없으면 사용자에게 프로젝트를 먼저 묻는다. 임의로 workspace 루트에 만들지 않는다.
