---
name: mermaid-pdf
description: "Markdown 파일을 Mermaid 다이어그램 포함 고품질 PDF로 변환. Puppeteer 기반, 한글 폰트 지원, Obsidian 스타일 CSS. Actions: convert, render, export. Triggers: mermaid, mermaid pdf, markdown pdf, 문서 변환, diagram pdf, md to pdf, 마크다운 PDF, 다이어그램 PDF."
version: 1.0.0
---

# mermaid-pdf — Markdown + Mermaid → PDF 변환

Markdown 파일을 Mermaid 다이어그램이 포함된 고품질 PDF로 변환한다.
Puppeteer(Chrome headless) 기반, Noto Sans KR 한글 폰트, Obsidian 스타일 CSS 적용.

## 안전 기본값 — 최종 PDF는 `pdf_export` 우선

이 스킬의 내장 `render_pdf.mjs`는 **Markdown → print-ready HTML 변환기**이자 legacy 직접 PDF fallback이다. 사용자-facing 최종 PDF는 가능하면 다음 경로를 기본으로 한다.

1. `render_pdf.mjs`로 Markdown을 HTML까지 변환한다.
2. 그 HTML을 Tower harness `pdf_export` tool로 최종 PDF export한다.
3. `pdf_export`가 반환한 verification image를 확인한다.
4. Mermaid/chart 원문이 그대로 보이면 완료로 보고하지 않고 HTML/소스를 고친 뒤 다시 export한다.

직접 `render_pdf.mjs <input.md> <output.pdf>`로 PDF까지 굽는 방식은 다음 경우의 fallback이다.
- 사용자가 의도적으로 스킬 내장 렌더러를 테스트/디버그한다.
- 현재 harness `pdf_export`를 사용할 수 없다.
- 현재 Project 실행면에서 중간 확인용 PDF가 필요하고 최종 전달본이 아니다.

## Execution Flow

```
1. 대상 마크다운 파일 확인
   ├── 사용자가 경로를 지정한 경우 → 해당 파일 사용
   └── 현재 작업 중인 md 파일이 있는 경우 → 해당 파일 사용

2. 실행 경로 확인
   ├── Project `bash`에서는 `.tower/skills/mermaid-pdf/scripts/` 사용
   ├── host-side `~/.claude/skills/...` 경로를 직접 열거나 실행하지 않음
   └── 의존성이 없으면 자동 설치를 반복하지 말고 사용자에게 필요한 설치/공유 런타임 상태를 보고

3. print-ready HTML 생성
   └── node .tower/skills/mermaid-pdf/scripts/render_pdf.mjs <input.md> <fallback.pdf> --html-out <output.html> --skip-pdf [options]

4. 최종 PDF export
   └── pdf_export(input_path=<output.html>, output_path=<output.pdf>) 사용

5. 셀프 리뷰 (필수!)
   ├── pdf_export verification image 확인
   ├── Mermaid 다이어그램이 렌더링되었는지
   ├── Mermaid/chart 코드 원문이 남지 않았는지
   ├── 한글 폰트가 정상 출력되는지
   ├── 코드블록/테이블/이미지 스타일 확인
   └── 문제 발견 시 마크다운/HTML 수정 → 재렌더 → pdf_export 재실행
```

---

## CLI 사용법

```bash
node .tower/skills/mermaid-pdf/scripts/render_pdf.mjs <input.md> <output.pdf> [options]

Options:
  --page-size    A4 | Letter | Legal  (기본: A4)
  --orientation  portrait | landscape (기본: portrait)
  --scale        0.5~2.0              (기본: 1.0)
  --margin       top,right,bottom,left in mm (기본: 35,22,35,22)
  --html-out     print-ready HTML도 함께 저장
  --skip-pdf     HTML만 생성하고 내장 Puppeteer PDF 렌더링은 건너뜀
```

일반 프로젝트에서는 `bash`로 실행한다. 입력/출력 파일은 현재 Project 안에 둔다. Worker-first에서는 Project Workstation을 사용하고 compatibility Project의 Runtime Box 선택은 Tower가 내부적으로 처리한다.

> **마진 기본값 노트 (2026-04-11):** 초기엔 `20,20,20,20` 이었으나 위아래가 너무 좁아 책 느낌이 안 나서 `35,22,35,22`로 조정.

### 예시

```bash
# 권장: Markdown → HTML 생성 후 pdf_export로 최종 PDF
node .tower/skills/mermaid-pdf/scripts/render_pdf.mjs report.md report.fallback.pdf --html-out report.html --skip-pdf
# 이후 Tower pdf_export tool: input_path=report.html, output_path=report.pdf

# fallback: 내장 렌더러로 직접 A4 세로 PDF 생성
node .tower/skills/mermaid-pdf/scripts/render_pdf.mjs report.md report.pdf

# Letter 가로, 스케일 0.8
node .tower/skills/mermaid-pdf/scripts/render_pdf.mjs report.md report.pdf --page-size Letter --orientation landscape --scale 0.8

# 커스텀 마진 (상10, 좌우15, 하10)
node .tower/skills/mermaid-pdf/scripts/render_pdf.mjs report.md report.pdf --margin 10,15,10,15
```

---

## 지원 기능

| 기능 | 설명 |
|------|------|
| **Mermaid 다이어그램** | flowchart, sequence, gantt, class, state, ER, pie, mindmap 등 |
| **한글 폰트** | Noto Sans KR (Google Fonts CDN) |
| **코드 블록** | 구문 하이라이팅 배경, Monaco 폰트 |
| **테이블** | GitHub Flavored Markdown 스타일 |
| **이미지** | 로컬 이미지 자동 base64 임베딩 |
| **수학식** | 미지원 (필요시 별도 플러그인) |

---

## 주의사항

1. **최종 PDF는 `pdf_export` 우선**: 내장 PDF 렌더러는 legacy fallback이며, 사용자-facing 최종본은 harness verification을 거친다.
2. **Chrome/Chromium 필수**: HTML 변환/직접 PDF fallback 모두 headless browser가 필요하다.
3. **네트워크 필요 가능성**: 첫 실행 시 Google Fonts + Mermaid.js CDN 로딩이 필요할 수 있다.
4. **YAML frontmatter**: 자동으로 제거됨 (PDF에 포함되지 않음)
5. **큰 다이어그램**: 페이지 폭을 초과하면 자동 축소 (max-width: 100%)

---

## ⚠️ 스크립트 수정 시 함정 — 마진 단일 소스 원칙

`render_pdf.mjs`를 수정할 때 반드시 지킬 것:

**마진은 오직 `page.pdf({ margin })` 옵션으로만 제어한다.** `body { padding }` 사용 금지.

### 왜?

CSS `body`는 **하나의 박스**이고 `padding-top`은 그 박스 위쪽에 한 번만 적용된다. 문서가 여러 페이지로 나뉘어도 **첫 페이지 상단만** 밀려나고, Chrome이 페이지를 넘기면 body 박스의 이어지는 부분을 그릴 뿐이라 **두 번째 페이지부터는 상단 여백이 0이 되는 버그**가 생긴다.

진짜 페이지 마진은 puppeteer의 `page.pdf({ margin })` 옵션이 담당해야 한다. 이게 CSS `@page` 박스의 마진으로 작동해서 **모든 페이지**에 동일하게 적용된다.

### 올바른 구조

```javascript
// ✅ 올바른 구조
body { padding: 0; margin: 0; }                    // body는 건드리지 않기
@page { size: 210mm 297mm; }                       // size만 지정, margin은 위임
page.pdf({                                         // 유일한 마진 소스
  margin: { top: '35mm', right: '22mm', bottom: '35mm', left: '22mm' }
})
```

### 잘못된 구조 (과거에 밟았던 함정)

```javascript
// ❌ 이중 소스 — 충돌 + 첫 페이지만 적용되는 버그
body { padding: 35mm 22mm; }                       // 첫 페이지 상단만 밀려남
@page { margin: 0; }                               // puppeteer와 충돌
page.pdf({ margin: { top: '35mm', ... } })         // @page: 0과 충돌
```

**기억하라:** `--margin` CLI 옵션을 바꿨는데 시각적 변화가 없거나, 두 번째 페이지부터 여백이 없어 보이면, 즉시 이 섹션을 다시 읽을 것.

*히스토리: 2026-04-11, 이 버그를 두 번 밟고 정리함.*

---

## 셀프 리뷰 체크포인트

PDF 렌더링 후 반드시 `pdf_export` verification image 또는 Read/PDF view로 확인:

- [ ] Mermaid 다이어그램이 SVG/시각 요소로 정상 렌더링되었는지
- [ ] `flowchart LR`, `sequenceDiagram`, ```mermaid 같은 원문이 남지 않았는지
- [ ] 한글 텍스트가 깨지지 않았는지
- [ ] 코드블록 배경색/폰트가 정상인지
- [ ] 테이블 테두리/정렬이 올바른지
- [ ] 이미지가 정상 출력되는지
- [ ] 페이지 분할이 적절한지 (heading 고아 방지)
- [ ] 전체 여백이 균일한지

문제 발견 시: 마크다운 수정 → 재렌더 → 재확인. 2~3회 반복 정상.
