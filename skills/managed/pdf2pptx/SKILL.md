---
name: pdf2pptx
description: |
  Convert PDF slide decks into native editable PPTX files by reconstructing each PDF page with python-pptx shapes, editable TextBoxes, tables, and local images while preserving the original look as closely as practical. Use when: "PDF를 PPT로", "PDF 슬라이드 PPTX 변환", "PDF에서 편집 가능한 피피티", "pdf2pptx", "PDF 발표자료 수정 가능하게", "convert PDF to editable PPTX". NOT for: 새 브랜드 템플릿 기반 PPTX 생성 → pptx-template. 생성된 PPTX 품질 검수 → pptx-review. 이미지 기반 새 슬라이드 생성 → image-slide-gen. HTML/PDF 슬라이드 제작 → html-slide.
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
argument-hint: "[path/to/source.pdf] [optional: output.pptx]"
requires:
  cli: [python3, libreoffice]
  python: [pptx, PIL, fitz]
  network: none
---

# pdf2pptx — PDF 슬라이드를 editable native PPTX로 재구성

PDF 슬라이드를 받아서 원본과 거의 동일하게 보이는 **편집 가능한 PPTX**를 만든다. 목적은 완벽한 픽셀 복제가 아니라, 사용자가 PowerPoint에서 텍스트 몇 줄·도형·표·이미지 위치를 다시 만질 수 있는 자료 형태를 확보하는 것이다.

핵심 아이디어는 다음 3가지다.

1. **모든 요소를 native로 만든다** — 텍스트는 TextBox, 선/도형은 Shape, 이미지는 Picture로 둔다.
2. **python-pptx의 함정을 프롬프트/작업 규칙에 박아둔다** — 점선, 폰트, 줄바꿈, 여백, 색상 처리 규칙을 명시한다.
3. **self-verification 루프를 돈다** — PPTX를 렌더링해서 원본 PDF 페이지와 나란히 비교하고, 눈에 띄는 오차만 최대 3회 수정한다.

## 언제 쓰나

- PDF 발표자료를 받아서 디자인은 유지하되 텍스트 몇 줄을 고치고 싶을 때
- 외부에서 받은 PDF 슬라이드를 편집 가능한 PPTX로 다시 만들고 싶을 때
- 원본 PPTX는 없고 PDF만 있는데, 후속 발표/제안서 수정이 필요한 때
- 이미지 한 장으로 붙인 PPTX가 아니라, 텍스트/도형/이미지가 따로 선택되는 native PPTX가 필요할 때

## 경계 — 기존 스킬과 비교

| 사용성 범주 | 스킬 | 쓰는 경우 | 이 스킬이 아닌 경우 |
|---|---|---|---|
| PDF → editable PPTX 복원 | `pdf2pptx` | PDF 슬라이드 원본을 최대한 보존하며 native PPTX로 재구성 | 새 덱을 기획/생성하는 일 |
| 템플릿 기반 PPTX 생성 | `pptx-template` | 브랜드 템플릿 + YAML 데이터로 새 제안서/보고서 PPTX 생성 | 원본 PDF 페이지를 복원하는 일 |
| PPTX 품질 검수 | `pptx-review` | 이미 만들어진 PPTX를 렌더링/비전으로 검수하고 수정 제안 | 변환 자체 |
| 이미지 슬라이드 생성 | `image-slide-gen` | gpt-image-2로 PNG 슬라이드 묶음 생성 | 편집 가능한 PPTX가 필요할 때 |
| HTML/PDF 슬라이드 제작 | `html-slide` | self-contained HTML과 PDF 결과물이 목적일 때 | PowerPoint native 편집성이 필요할 때 |

`pptx-edit`가 있는 환경에서는 기존 PPTX의 일부 수정은 `pptx-edit`로 보낸다. `pdf2pptx`는 **PPTX가 없고 PDF만 있는 상황**이 주 대상이다.

## 출력 계약

표준 산출물 폴더:

```text
presentations/YYYY-MM-DD_<topic>_pdf2pptx/
├── source.pdf
├── source_pages/
│   ├── page_001.png
│   └── page_002.png
├── output.pptx
├── rendered_pptx/
│   ├── slide_001.png
│   └── slide_002.png
└── notes.md
```

반드시 최종 보고에는 `output.pptx`의 절대경로를 포함한다.

## Step 1 — 입력과 목표 확인

사용자가 PDF 경로를 주면 바로 진행한다. 다음 정보가 없으면 기본값으로 진행하되, 결과가 크게 달라질 때만 짧게 묻는다.

- 출력 파일명: 기본 `output.pptx`
- 변환 범위: 기본 전체 페이지
- 우선순위: 기본 `편집 가능성 > 원본 유사도 > 픽셀 완전성`

사용자에게 처음부터 픽셀 단위 완벽 복제를 약속하지 않는다. 이 스킬의 목적은 “디자인이 대체로 유지되고, 중요한 텍스트/도형/이미지를 PowerPoint에서 고칠 수 있는 파일”이다.

## Step 2 — PDF 페이지 렌더링

PDF는 시각 문서다. 먼저 각 페이지를 PNG로 렌더링해서 원본 기준 이미지를 확보한다.

권장:

```bash
python3 - <<'PY'
import fitz, pathlib, sys
pdf = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
doc = fitz.open(pdf)
for i, page in enumerate(doc, 1):
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    pix.save(out / f"page_{i:03d}.png")
print(f"rendered {len(doc)} pages")
PY source.pdf source_pages
```

`fitz`가 없으면 현재 환경의 PDF 렌더링 도구를 사용한다. Tower에서는 PDF를 읽을 때 시각 렌더링 경로를 우선한다.

## Step 3 — 페이지 분석

각 PDF 페이지를 보며 요소를 분리한다.

- 배경: 단색/그라데이션/사진/복잡한 패턴
- 텍스트: 제목, 본문, 라벨, 축, 각주, 페이지 번호
- 도형: 선, 박스, 원, 화살표, 칩, 카드, 차트 막대
- 이미지: 사진, 아이콘, 로고, 스크린샷
- 표/차트: 재현 가능한 native table/shape인지, 이미지로 두는 편이 나은지 판단

가능하면 텍스트는 PDF text layer에서 추출한다. 단, 좌표/문단 흐름이 깨지면 이미지 기준으로 사람이 읽을 수 있는 수준의 텍스트를 재구성한다.

## Step 4 — PPTX를 native 요소로 재구성

`python-pptx`를 사용한다. 기본 슬라이드 크기는 PDF 페이지 비율에 맞춘다. 보통 16:9 PDF 슬라이드는 wide로 둔다.

### 4.1 금지/허용 원칙

- 텍스트는 편집 가능한 `TextBox`만 허용한다.
- 텍스트를 이미지로 변환하지 않는다.
- SmartArt 변환, SVG 삽입, 전체 페이지 스크린샷 한 장 삽입으로 끝내는 방식을 금지한다.
- 도형은 개별 선택과 크기 조절이 가능한 `Shape`로 만든다.
- 복잡한 사진/스크린샷은 이미지로 두되, 텍스트 라벨은 가능하면 별도 TextBox로 올린다.

PDF를 PPT로 바꾸는 이유는 편집인데, 핵심 요소가 편집되지 않으면 의미가 없다.

### 4.2 python-pptx 함정 규칙

#### 점선/테두리

점선 테두리는 `prstDash` 계열 속성으로 지정한다. AI가 선을 하나씩 직접 배치하면 간격이 불균일해지고 모서리가 망가지기 쉽다.

- `dash`
- `sysDash`
- `sysDot`

가능하면 도형 line format의 dash preset을 사용하고, 수동 반복 선 조합은 피한다.

#### 폰트

한글/영어/숫자 혼용 텍스트는 서체를 세 군데에 맞춘다.

- Latin
- East Asian
- Complex script가 필요한 경우 해당 run

하나만 지정하면 한글·영어·숫자 사이에 이상한 반각 간격이나 fallback 차이가 생길 수 있다.

기본 권장:

- Korean: `Pretendard`, `Noto Sans KR`, `Malgun Gothic`
- English fallback: `Arial`, `Aptos`

#### TextBox 여백과 줄바꿈

텍스트 박스는 오른쪽에 충분한 여백을 둔다.

- 오른쪽 여백 30–100pt 확보
- 마지막 글자가 잘리면 박스를 넓히거나 폰트를 줄인다.
- 불필요한 자동 줄바꿈이 레이아웃을 망치면 `word_wrap = False`를 검토한다.
- 여러 줄 본문은 줄 높이와 paragraph spacing을 직접 조정한다.

#### 색상

색상은 원본에서 HEX 값을 최대한 정확히 추출한다. “비슷한 색”으로 타협하면 슬라이드 전체가 지저분해진다.

- 주요 배경색
- 본문 텍스트색
- 강조색
- 선/테두리색
- 차트 색상

이미지 샘플링이 필요하면 원본 PNG에서 픽셀을 찍어 근사 HEX를 기록한다.

## Step 5 — self-verification 루프

PPTX를 만든 뒤 반드시 렌더링해서 원본 PDF 페이지 이미지와 비교한다.

루프:

1. `output.pptx` 생성
2. LibreOffice 등으로 PNG 렌더링
3. 원본 `source_pages/page_XXX.png`와 `rendered_pptx/slide_XXX.png`를 나란히 확인
4. 눈에 띄는 오차만 수정
5. 최대 3회 반복

주의:

- 점선은 PNG 렌더링에서 깨져 보일 수 있다. 실제 PowerPoint에서 정상인 경우가 많으므로, 점선 깨짐만으로 무한 수정하지 않는다.
- 픽셀 단위 완벽함을 추구하면 오히려 레이아웃이 깨진다.
- 수정 기준은 “눈에 띄는 오차”다. 발표/편집 목적에서 문제가 되는 오차만 고친다.

## Step 6 — 검수 기준

완료 전에 확인한다.

- 슬라이드 수가 PDF 페이지 수와 맞는가?
- 페이지 크기/비율이 원본과 맞는가?
- 주요 텍스트가 TextBox로 선택/편집 가능한가?
- 큰 도형과 선이 Shape로 선택 가능한가?
- 이미지가 필요한 곳만 Picture로 들어갔는가?
- 원본과 비교했을 때 눈에 띄는 위치/크기/색상 오차가 3회 루프 후 허용 가능한가?
- PowerPoint/LibreOffice에서 열리는가?

## Step 7 — 사용자 보고

보고할 내용:

1. 변환한 페이지 수
2. 최종 PPTX 경로
3. 원본 유사도/편집 가능성에 대한 짧은 평가
4. 남은 한계: 이미지로 유지한 요소, 완전히 native화하지 못한 표/차트 등
5. 필요 시 다음 액션: 특정 페이지 재작업, 텍스트 수정, pptx-review 검수

## Test Pack

| Type | JTBD | Success |
|---|---|---|
| Primary | 5쪽짜리 PDF 슬라이드 → editable PPTX 변환 | 5쪽 모두 생성, 주요 텍스트 TextBox, 원본과 눈에 띄게 유사 |
| Primary | PDF에서 텍스트 몇 줄만 고쳐야 함 | 변환 후 해당 텍스트를 PowerPoint에서 직접 편집 가능 |
| Edge | 점선/테두리 많은 슬라이드 | 점선이 수동 조각이 아니라 line dash preset으로 처리 |
| Edge | 한글+영어+숫자 혼용 | 폰트 fallback/간격이 크게 깨지지 않음 |
| Edge | 복잡한 차트/사진 많은 슬라이드 | 사진은 이미지로 두고 라벨/제목은 editable TextBox로 분리 |
| Regression | 렌더 PNG의 점선 깨짐을 오류로 오판 | 실제 PPTX 정상 가능성을 고려하고 불필요한 수정 루프 중단 |

## 원본 아이디어 출처

이 스킬은 “PDF를 PPT로 바꾸는 만능 프롬프트” 아이디어를 Tower의 스킬 경계에 맞춰 정리한 것이다. 핵심 규칙은 다음 공개 포스트의 요지를 반영한다.

- 모든 요소를 native로 만들기
- python-pptx 함정을 프롬프트에 명시하기
- self-verification 루프 추가하기

외부 포스트/프롬프트 원문을 그대로 실행 경로로 쓰지 않고, Tower의 프로젝트 산출물·Runtime Box·기존 PPT 스킬 경계에 맞게 보수적으로 옮긴다.
