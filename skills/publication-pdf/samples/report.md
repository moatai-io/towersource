---
title: 출판물 수준 PDF 제작 점검
subtitle: Publication PDF 최소 샘플
author: Tower 문서팀
date: 2026-07-14
lang: ko
---

# 결론

`publication-pdf`는 원고를 바로 PDF로 바꾸는 변환기가 아니다. 먼저 내용을 구조화한 Markdown을 만들고, 고정된 Typst 템플릿으로 조판한 다음, 자동 검사와 사람의 눈검수를 거쳐 **출판물 수준의 PDF**를 완성한다.

> 핵심 원칙: 페이지 수를 억지로 줄이기보다 제목과 문단이 충분히 숨 쉴 수 있는 수직 리듬을 우선한다.

# 제작 흐름

```{.mermaid caption="Publication PDF의 제작 흐름" alt="원고를 Markdown으로 정규화하고 Typst PDF로 조판한 뒤 검수하는 과정"}
flowchart LR
  A[원고] --> B[출판용 Markdown]
  B --> C[Typst 조판]
  C --> D[자동 postflight]
  D --> E[페이지 눈검수]
  E --> F[최종 PDF]
```

# 지원 요소

## 비교 표

| 요소 | 작성 단계 | 검증 기준 |
|---|---|---|
| 제목 | 위계를 지킨다 | 고아 제목이 없다 |
| 본문 | 문단을 빈 줄로 나눈다 | 행간과 문단 간격이 읽기 편하다 |
| 표 | 열 수와 문장 길이를 줄인다 | 페이지 폭을 넘지 않는다 |
| 그림 | caption과 alt를 쓴다 | 원문 코드가 노출되지 않는다 |

## 코드와 수식

```typst
#set par(leading: 0.94em, spacing: 1.25em)
```

인라인 수식 $E = mc^2$와 각주도 구조적으로 보존한다.[^note]

[^note]: 최종 지원 범위는 fixture와 시각 검수로 확인한다.

# 완료 기준

1. `publication.md`가 Viewer에서 읽기 좋다.
2. `publication.typ`과 PDF를 같은 입력에서 재생성할 수 있다.
3. 한국어 폰트, A4, 텍스트 추출, Mermaid 전처리가 통과한다.
4. 최종 페이지를 눈으로 확인한다.
