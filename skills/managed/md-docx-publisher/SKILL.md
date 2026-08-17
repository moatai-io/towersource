---
name: md-docx-publisher
description: |
  Converts Markdown into polished, publishing-grade DOCX using Pandoc, reference.docx, and uv-run Python postprocessing. Use when users say "md를 docx로", "마크다운 워드 변환", "Google Docs에 올릴 문서", "보고서 DOCX", "publishing급 문서", "표/이미지까지 예쁘게 Word로". NOT for PDF-only slide decks (→ html-slide/mermaid-pdf) or editing existing arbitrary DOCX files.
version: 1.0.0
tags: [docs]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, WebSearch, WebFetch
argument-hint: "[input.md] [output.docx]"
---

# md-docx-publisher

Markdown을 “대충 Word”가 아니라 Google Docs에 올려도 구조가 무너지지 않는 출판물형 DOCX로 만든다.

## Default pipeline

1. 입력 Markdown을 확인한다.
   - H1/H2/H3, list, table, image가 의미적으로 쓰였는지 본다.
   - 열이 많은 표는 그대로 밀어붙이지 말고, 필요하면 card/list 구조로 바꿀지 제안한다.
2. 변환은 스크립트로 한다.

```bash
uv run --script /workspace/.tower/skills/md-docx-publisher/scripts/md_docx_publisher.py input.md output.docx --profile publish
```

이미지가 많은 문서는 기본적으로 1600px 초과 래스터 이미지를 축소한다. 필요하면 조정한다.

```bash
uv run --script /workspace/.tower/skills/md-docx-publisher/scripts/md_docx_publisher.py input.md output.docx --max-image-width 1600 --image-quality 88
```

프로젝트 source에서 검증 중이면:

```bash
uv run --script skills/md-docx-publisher/scripts/md_docx_publisher.py input.md output.docx --profile publish
```

3. 고객/브랜드 색이 있으면 `--profile hantoo` 또는 `--reference-doc custom-reference.docx`를 쓴다.
4. 최종 DOCX는 가능하면 LibreOffice headless로 PDF 렌더링해 눈검수한다.

## Quality bar

- Word/Google Docs에서 깨지기 쉬운 text box, floating shape, 복잡한 section trick을 쓰지 않는다.
- 이미지는 inline, centered, 파일 기반이어야 한다.
- Mermaid는 PNG로 렌더링해 삽입한다. mmdc가 없으면 코드블록으로 남긴다.
- 색은 푸른색 기본값을 피하고 검정/따뜻한 회색 중심으로 제목과 표를 잡는다.
- 표는 헤더 배경, 얇은 테두리, alternate row, row split 방지를 적용한다.
- heading은 keep-with-next로 다음 문단과 붙인다.
- ASCII 다이어그램은 코드블록 텍스트로 두면 폰트/공백이 깨질 수 있으므로 PNG로 굽는다.
- 페이지 여백/문단 간격/본문 폰트는 Markdown이 아니라 DOCX style/postprocess에서 통일한다.

## Input authoring rules

```markdown
# 문서 제목

## 1. 섹션

짧은 문단으로 쓴다. Google Docs import까지 생각하면 긴 문단보다 3~5줄 단위가 안전하다.

| 항목 | 내용 | 상태 |
|---|---|---|
| A | 설명 | 완료 |

![설명](images/figure.png)
```

피할 것:

- HTML table, CSS, div 기반 레이아웃
- base64 image
- 8열 이상 wide table
- 이미지 옆 텍스트 감싸기
- DOCX에서만 되는 text box/shape 의존

## Research notes

상세 조사와 OSS 판단은 [reference.md](reference.md)를 먼저 읽는다.

## Failure modes

| 증상 | 처리 |
|---|---|
| 표가 너무 넓다 | Markdown 단계에서 bullet/card로 재구성하거나 landscape section은 마지막 수단으로만 쓴다. |
| 이미지가 안 들어간다 | Markdown 파일 기준 상대 경로가 맞는지 확인한다. |
| DOCX가 너무 무겁다 | `--max-image-width 1200 --image-quality 84`처럼 낮춘다. 원본 보존이 필요하면 `--max-image-width 0`을 쓴다. |
| Mermaid가 코드로 남는다 | `mmdc` 설치 여부를 확인한다. 없으면 PNG를 별도 생성해 Markdown image로 넣는다. |
| ASCII 정렬이 깨진다 | fenced block 언어를 `ascii`, `diagram`, `textdiagram`, `txt` 중 하나로 지정한다. 스크립트가 PNG로 렌더링한다. |
| Google Docs에서 레이아웃이 변한다 | floating/shape/section 의존을 제거하고 inline image + real table/list로 단순화한다. |
