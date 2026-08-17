# md-docx-publisher reference

## 결론

가장 안정적인 OSS 축은 **Pandoc + reference.docx + 후처리(OpenXML/python-docx)** 이다. Google Docs까지 고려하면 “예쁜 Word 기능”보다 “구조가 단순한 출판물”이 이긴다.

## 조사 요약

- Pandoc은 Markdown→DOCX의 사실상 표준 OSS다. Markdown AST를 거치므로 구조 보존은 강하지만 복잡한 레이아웃/서식 세부는 손실될 수 있다.
- Pandoc/Quarto의 `reference.docx`는 Word 스타일의 정본이다. 제목, 본문, 코드, 표 스타일을 Word에서 수정한 뒤 재사용하는 방식이 공식 권장 흐름이다.
- Pandoc의 표 스타일은 reference만으로 완벽하지 않은 케이스가 있다. 그래서 변환 후 `python-docx`/OpenXML로 테두리, 헤더 배경, 줄 나눔 방지, 셀 패딩을 한 번 더 잡는다.
- Google Docs import는 floating object, text box, complex shape, section trick에 약하다. inline image, real heading/list/table, centered image, 짧은 문단이 안전하다.
- Quarto는 Pandoc 위의 publishing layer다. 코드 실행/논문형 문서에는 좋지만, 단일 스킬 스크립트는 Pandoc 직호출이 더 작고 예측 가능하다.

## 좋은 DOCX를 만드는 규칙

1. **Markdown은 의미 중심으로 쓴다**: H1/H2/H3, list, table, image, blockquote를 제대로 쓴다.
2. **레이아웃은 reference.docx와 후처리에서 한다**: Markdown 안에 HTML/CSS를 많이 넣지 않는다.
3. **표는 한 페이지 폭 안에 들어가게 만든다**: 열이 너무 많으면 Markdown 단계에서 세로형 bullet/card로 바꾼다.
4. **이미지는 파일로 삽입한다**: copy/paste나 base64보다 `![caption](path.png)`가 Google Docs에 안전하다.
5. **다이어그램은 PNG로 굽는다**: Mermaid/SVG는 DOCX 내부에서 호환성이 갈리므로 PNG가 안전하다.
6. **페이지 간격은 style로 해결한다**: heading keep-with-next, table row cantSplit, 문단 before/after를 통일한다.
7. **검수는 LibreOffice/PDF로 한 번 본다**: DOCX 자체는 구조물이라 최종 눈검수는 렌더링 결과로 한다.

## 주요 OSS/도구

| 도구 | 용도 | 채택 판단 |
|---|---|---|
| Pandoc | Markdown→DOCX 변환 핵심 | 채택 |
| python-docx | 변환 후 스타일/표/문단 보정 | 채택 |
| Mermaid CLI | mermaid code block → PNG | 있으면 사용 |
| LibreOffice headless | DOCX→PDF 눈검수 | 검수용 |
| Quarto | 고급 publishing wrapper | 필요할 때만 |
| md2docx 계열 Python 라이브러리 | 단순 변환 | Pandoc보다 약함 |

## 참고 URL

- Pandoc Manual: https://pandoc.org/MANUAL.html
- Pandoc GitHub: https://github.com/jgm/pandoc
- Quarto Word Templates: https://quarto.org/docs/output-formats/ms-word-templates.html
- Quarto DOCX Options: https://quarto.org/docs/reference/formats/docx.html
- Pandoc table style issue: https://github.com/jgm/pandoc/issues/3275
- Google Docs/Word import tips: https://learn.designrr.io/en/articles/9770889-how-to-format-word-docs-docx-and-google-docs-for-import-video
