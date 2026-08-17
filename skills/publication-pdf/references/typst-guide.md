# Typst 문법·템플릿 안내

기준 버전: Typst 0.15.0

## 공식 학습 경로

- 공식 문법: https://typst.app/docs/reference/syntax/
- 공식 튜토리얼: https://typst.app/docs/tutorial/
- 템플릿 만들기: https://typst.app/docs/tutorial/making-a-template/
- 함수·조판 레퍼런스: https://typst.app/docs/reference/
- 공식 package·template gallery: https://typst.app/universe/
- Universe template 검색: https://typst.app/universe/search/?kind=templates
- Universe package 검색: https://typst.app/universe/search/?kind=packages
- compiler source/release: https://github.com/typst/typst

온라인 gallery는 아이디어와 후보를 찾는 곳이지 Runtime Box의 자동 의존성 공급처가 아니다. production에 쓸 template/package는 버전과 라이선스를 확인하고, 네트워크 없이 재현되도록 vendoring 또는 package cache 고정을 검토한다.

## 세 가지 모드

Typst에는 markup, math, code 모드가 있다.

```typst
= Markup 제목
본문에 *굵게*와 _강조_를 쓴다.

$ E = m c^2 $       // math

#pagebreak()        // code: #으로 진입
```

code 안에서는 다시 `#`를 반복하지 않는다.

```typst
#let accent = rgb("2563eb")
#text(fill: accent)[강조 문장]
```

## 자주 쓰는 markup

```typst
= 대제목
== 소제목

*굵게*, _강조_, `inline raw`

- 불릿
- 불릿

+ 번호 항목
+ 번호 항목

/ 용어: 설명

> 인용문

https://typst.app/
```

Markdown과 다른 점:

- 제목은 `# 제목`이 아니라 `= 제목`이다.
- 번호 목록은 `1.`이 아니라 `+`다.
- code/function 호출은 `#function(...)`이다.
- content 인자는 대괄호 `[내용]`으로 감싼다.

## 페이지와 본문

```typst
#set page(
  paper: "a4",
  margin: (x: 22mm, top: 25mm, bottom: 24mm),
  numbering: "1 / 1",
)

#set text(
  font: ("Pretendard", "Noto Sans CJK KR"),
  size: 10.3pt,
  lang: "ko",
)

#set par(
  justify: false,
  leading: 0.94em,
  spacing: 1.25em,
)
```

- `leading`: 같은 문단 안의 줄 간격
- `spacing`: 문단과 다음 문단 사이 간격
- 제목 여백은 heading show rule의 `above`, `below`로 별도 조정한다.

## 제목 스타일

```typst
#show heading.where(level: 1): it => block(
  above: 30pt,
  below: 26pt,
  breakable: false,
)[
  #text(size: 21pt, weight: "bold")[#it]
]
```

`breakable: false`는 제목 block 자체가 갈라지는 것을 막지만, 제목과 뒤 문단의 모든 고아 문제를 자동 해결하지는 않는다. 최종 PDF를 눈으로 확인한다.

## 표

```typst
#table(
  columns: (2fr, 1fr, 1fr),
  inset: 7pt,
  [항목], [현재], [목표],
  [처리 시간], [12분], [8분],
)
```

열 너비는 `auto`, 절대 길이, `fr` 조합으로 정한다. 넓은 표를 단순 축소하면 글자가 너무 작아지므로 구조를 먼저 바꾼다.

## 이미지와 figure

```typst
#figure(
  image("assets/chart.png", width: 90%),
  caption: [처리 단계 비교],
) <result-chart>

본문에서 @result-chart 를 참조한다.
```

## 템플릿 기본 형태

Typst template은 문서 전체를 감싸는 함수다.

```typst
// template.typ
#let report(
  title: none,
  author: none,
  body,
) = {
  set page(paper: "a4")
  set text(font: "Pretendard", lang: "ko")

  if title != none {
    align(center)[#text(size: 24pt, weight: "bold")[#title]]
  }

  body
}
```

사용:

```typst
#import "template.typ": report

#show: report.with(
  title: [월간 운영 보고서],
  author: [운영팀],
)

= 요약
본문...
```

## 외부 template 도입 체크

1. 문서 목적이 보고서·논문·책·CV·슬라이드 중 무엇인지 확인한다.
2. 라이선스와 유지 상태를 확인한다.
3. 지원 Typst 버전을 확인한다.
4. A4와 한국어 font fallback을 확인한다.
5. 외부 package import와 network/cache 요구를 확인한다.
6. 짧은 문서·긴 문서·표·코드·한글 fixture로 렌더한다.
7. 기존 template을 덮어쓰지 말고 별도 이름과 버전으로 보존한다.

## 로컬 sample

이 스킬에는 다음이 포함된다.

```text
samples/report.md
samples/report.typ
samples/report.pdf   # smoke/eval 후 생성 가능
```

기본 template 정본:

```text
templates/tower-report.typ
```

처음부터 복잡한 Universe template을 가져오기보다 기본 template으로 원고 구조와 출판 흐름을 확인한 뒤 확장한다.
