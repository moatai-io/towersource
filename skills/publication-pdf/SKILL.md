---
name: publication-pdf
description: |
  Markdown 원고를 구조화하고 반복 조판·시각 검수해 출판물 수준의 PDF로 완성한다. Use when: Markdown→PDF 품질이 특히 중요할 때, 고객 제출용 보고서·백서·제안서·매뉴얼, "출판 품질 PDF", "PDF를 제대로 조판", `/publication-pdf`. NOT for: 빠른 단순 변환, 준비된 HTML 출력, 슬라이드, DOCX.
version: 0.2.1
tags: [docs, file-writing]
allowed-tools: Read, Write, Edit, Bash
argument-hint: "[draft|publish|check] [input.md] [output-dir]"
---

# Publication PDF

**Markdown에서 PDF로 갈 때 결과 품질이 특히 중요한 문서**를 대상으로 한다. 원고를 바로 변환하지 않고 **내용 구조 → 출판용 Markdown → Typst 조판 → PDF 눈검수** 순서로 완성한다. 사용자는 Typst를 알 필요가 없으며, 직접 원본을 손보고 싶을 때만 [Typst 문법·템플릿 안내](references/typst-guide.md)를 제공한다.

## 실행 모드

| 모드 | 결과 | Typst 실행 |
|---|---|---|
| `draft` | 정규화한 `publication.md`를 만들고 Viewer에서 내용 확인 | 안 함 |
| `publish` | Markdown·Typst source·최종 PDF·검증 기록 생성 | 실행 |
| `check` | 기존 `.typ` 또는 PDF의 문법·폰트·페이지·시각 품질 점검 | 필요 시 실행 |

모드가 명확하지 않으면 다음 기준으로 고른다.

- “초안”, “먼저 내용 보여줘”, “PDF는 아직” → `draft`
- “PDF까지”, “출판”, “최종본”, “Typst로 만들어” → `publish`
- “문법 봐줘”, “깨졌어”, “템플릿 검수” → `check`

## 입력과 산출물

입력은 Markdown 또는 원고 자료다. 프로젝트 scaffold가 있으면 이를 우선하고, 기본 산출물은 다음과 같다.

```text
work/<document-name>/publication.md
work/<document-name>/publication.typ
work/<document-name>/assets/
work/<document-name>/verification.md
final/<document-name>.pdf
```

기존 파일을 덮어쓸 가능성이 있으면 먼저 위치·파일 수·덮어쓰기 여부를 짧게 확인한다. 새 파일이면 가역적인 이름을 정해 진행한다.

파일을 만들기 전에는 다음 네 가지를 한두 문장으로 알린다.

```text
위치: work/<name>/ 원본 3개 + final/<name>.pdf
형식: Markdown + Typst + PDF
개수: 핵심 산출물 3개와 검증 기록
기존 파일: 새 이름 사용 또는 덮어쓰기 확인
```

## 핵심 흐름

### 1. 원고 구조 편집

독자, 문서 목적, 원하는 분량을 문맥에서 추론한다. 결과를 바꿀 정도로 불명확할 때만 한 가지를 묻는다.

원고를 다음 Markdown 계약으로 정규화한다.

- YAML metadata에 `title`, 필요하면 `subtitle`, `author`, `date`를 둔다.
- `#`는 장, `##`는 절로 사용하고 단계는 건너뛰지 않는다.
- 문단은 빈 줄로 분리한다. 제목처럼 보이게 굵은 글씨만 쓰지 않는다.
- 표는 A4 세로 폭을 기준으로 보통 5~6열 이하로 유지한다. 넓으면 분리·전치·가로 페이지 중 하나를 제안한다.
- 그림·Mermaid에는 독자가 이해할 수 있는 caption과 alt를 둔다.
- 강제 페이지 분할은 꼭 필요할 때만 raw Typst block으로 넣는다.

```markdown
```{=typst}
#pagebreak()
```
```

지원 문법과 예시는 [Markdown 작성 계약](references/markdown-contract.md)을 따른다.

### 2. `draft` 미리보기

`publication.md`를 저장하고 Tower Viewer Pane에 제시한다. Markdown 검토 단계에서는 Typst를 실행하지 않는다.

검토할 것:

- 결론과 독자가 명확한가
- 제목 위계가 자연스러운가
- 표·그림이 본문에서 설명되는가
- 불필요한 중복과 지나치게 긴 문단이 없는가

### 3. `publish` 빌드

Project Runtime Box 안에서 아래 도구가 보여야 한다.

```bash
typst --version    # 0.15.0
pandoc --version   # 3.10
mmdc --version     # 11.16.0
```

스킬은 host-global 경로를 사용하지 않는다. Runtime Box에서는 materialized skill directory를 찾고 그 안의 `scripts/build.sh`를 실행한다. 현재 프로젝트 로컬 authoring 환경에서는 이 스킬 폴더의 같은 스크립트를 사용할 수 있다.

```bash
bash <skill-dir>/scripts/build.sh \
  <publication.md> \
  <final.pdf> \
  <work-dir>
```

빌드 스크립트는 다음을 수행한다.

```text
Markdown
→ Pandoc 3.10 Typst writer
→ Mermaid fence를 PNG로 전처리
→ tower-report.typ
→ Typst 0.15.0
→ A4 PDF + publication.typ + verification files
```

외부 Typst package를 실행 중 다운로드하지 않는다. 기본 템플릿은 스킬에 포함된 `templates/tower-report.typ` 하나만 사용한다.

### 4. 출판 품질 검수

자동 검증 통과만으로 끝내지 않는다.

1. `pdfinfo`, `pdffonts`, `pdftotext` 결과를 확인한다.
2. `pdf_view`로 첫 페이지, 표·그림이 있는 페이지, 마지막 페이지를 본다. 5페이지 이하면 전 페이지를 본다.
3. 다음을 점검한다.
   - 한국어 글리프와 굵기가 정상인가
   - 대제목·소제목·본문 사이가 덕지덕지 붙지 않았는가
   - 제목이 페이지 아래에 고립되지 않았는가
   - 표와 코드가 잘리지 않았는가
   - Mermaid 원문이 남지 않았는가
   - 빈 페이지와 과도한 여백이 없는가
4. 문제가 있으면 원고 구조 또는 템플릿 값을 한 종류만 조정한 뒤 다시 빌드한다.
5. 최종 PDF와 `publication.md`를 Viewer에 제시한다.

## Typst 직접 편집

사용자가 `.typ` 파일을 직접 수정하거나 문법을 묻는 경우 [Typst 문법·템플릿 안내](references/typst-guide.md)를 먼저 읽는다. 핵심 구분은 다음과 같다.

```typst
= 제목                 // markup
*굵게*, _강조_
- 불릿
+ 번호 목록
$ E = m c^2 $          // math
#pagebreak()           // code
#set par(leading: 0.94em, spacing: 1.25em)
```

템플릿이나 package 예시는 공식 Typst Universe에서 찾을 수 있지만, 바로 production 문서에 도입하지 않는다. 라이선스·버전·네트워크 의존성·한국어 폰트·A4 페이지 분할을 별도 fixture로 검증한 뒤 vendoring 또는 고정 여부를 결정한다.

## 경계

- 준비된 HTML을 그대로 PDF로 출력 → `pdf_export`
- 빠른 Markdown+Mermaid PDF → `mermaid-pdf`
- 출판물 수준 DOCX → `md-docx-publisher`
- HTML/CSS 슬라이드 → `html-slide`
- 사용자 임의 `.typ` code를 신뢰 경계 밖에서 실행하지 않는다.
- 실패를 Chromium 결과로 조용히 대체하지 않는다. 어떤 단계가 실패했는지 보고한다.

## 완료 조건

- `publication.md`, `publication.typ`, 최종 PDF가 프로젝트 안에 존재한다.
- Runtime Box toolchain 버전 확인과 자동 postflight가 통과한다.
- PDF 시각 검수를 완료한다.
- 사용자에게 최종 파일의 절대 경로를 각각 한 줄로 안내한다.
