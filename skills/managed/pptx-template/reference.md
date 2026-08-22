# pptx-template — YAML schema & layout catalog (v0.3 한국식)

v0.3 부터 **한국식 컨설팅 톤** (한투운용 / PwC 한국 / demo-org 패턴) 으로 디폴트.
헤더 바, takeaway, insight 콜아웃, footer (출처·페이지·대외비), 챕터 트래커, 목차, 3단 분할.

## YAML 전체 구조

```yaml
meta:
  title: "키움 조건검색식 AI 답변 시스템"
  subtitle: "Markdown Brain System · 제안서"
  presenter: "EXAMPLE ORG · 김예시"
  date: "2026-04-17"

  # ── 한국식 chrome (모든 콘텐츠 슬라이드에 자동 적용) ──
  company: "EXAMPLE ORG"                          # 헤더 좌
  project_short: "키움 MBS"                   # 헤더 가운데
  confidential: "대외비"                      # 헤더 우 (옵션, 금융권 필수)
  source_default: "EXAMPLE ORG · proposal.md v1.0"  # 모든 슬라이드 footer 출처

  # ── 챕터 진행 트래커 (section 페이지에서 활용) ──
  chapters:
    - "01. 왜 지금"
    - "02. 무엇을"
    - "03. 12주 계획"
    - "04. 권리·비용"

theme:                              # optional
  primary: "1F3A68"
  accent:  "F5A623"
  text:    "222222"
  muted:   "6B7280"
  bg:      "FFFFFF"
  panel:   "F5F7FA"
  border:  "D1D5DB"
  font:    "Noto Sans CJK KR"
  bullet_char: "●"                  # ● ◆ ▪ • — Arial 안전 마커 (▶ 비추: fallback 깨짐)

slides:
  - layout: <name>
    # 모든 콘텐츠 슬라이드 (bullets/comparison/kpi/feature_grid/timeline/split/toc) 공통:
    chapter: "01. 왜 지금"     # optional, 헤더 가운데에 표시
    takeaway: "낮은 채택률의 근본 원인 = 4가지 메커니즘"  # optional, 제목 아래 한 줄
    insight: "MBS 는 증류 시점에 모두 해소"               # optional, 하단 결론 콜아웃
    source: "Karpathy 2026-04 / Li et al."               # optional, footer 출처 override
    # ... layout-specific fields ...
```

---

## Layout 카탈로그 (v0.3, 11개)

### `title` — 표지 (dark hero)
```yaml
- layout: title
  title: "키움 조건검색식 AI 답변 시스템"
  subtitle: "Markdown Brain System · 권오윤 팀장님께"
```

### `cover_short` — 두문 (한 줄 가치 제안)
```yaml
- layout: cover_short
  headline: "조용한 실패를 구조적으로 회피하는 시스템"
  subline: "청크 RAG → LLM-managed Knowledge Base · Karpathy · Li et al."
```
한국 제안서 표지 직후에 들어가는 "두문" 슬라이드. 핵심 메시지 한 줄 + 부제. 큰 표지보다 가벼움.

### `toc` — 목차 (필수, 5쪽 이상 덱)
```yaml
- layout: toc
  title: "목차"
  items:
    - { number: "01", title: "왜 지금, 왜 이 시스템인가", page: "04" }
    - { number: "02", title: "무엇을 만드나",            page: "06" }
    - { number: "03", title: "12주 계획 · KPI",         page: "10" }
```
`items` 미지정 시 `meta.chapters` 자동 사용. 4개 이하면 1열, 5개 이상이면 2열.

### `section` — 섹션 표지 + 진행 트래커
```yaml
- layout: section
  number: "01"
  title: "왜 지금, 왜 이 시스템인가"
  caption: "청크 RAG → LLM 관리 지식 베이스로의 업계 이동"
  chapter_idx: 0           # meta.chapters 의 0-based 인덱스 (트래커 강조)
```
하단에 모든 챕터를 작은 바로 표시, 현재 챕터만 오렌지 강조 + bold.

### `bullets` — 불릿 본문 (한국식 chrome 자동)
```yaml
- layout: bullets
  chapter: "01. 왜 지금"
  title: "기존 자동답변의 \"조용한 실패\""
  takeaway: "낮은 채택률의 근본 원인 = 4가지 메커니즘"
  bullets:
    - "청크 경계 손상 — 한 개념이 두 청크로 잘림"
    - "의미 유사성 착시 — 관련 없는 청크가 top-k 에 올라옴"
    - "..."
  insight: "MBS 는 증류 시점에 모두 해소 후 런타임에 올림"
  source: "Karpathy 2026-04 · Li et al."
  bullet_char: "●"          # 슬라이드별 override
```

### `comparison` — 2~3 열 비교표
```yaml
- layout: comparison
  title: "청크 RAG vs MBS"
  takeaway: "런타임 검색 → 사전 증류로 패러다임 이동"
  columns: ["항목", "기존 청크 RAG", "MBS"]
  rows:
    - ["증류 시점", "런타임", "사전 증류"]
    - ["..."]
  insight: "감사 가능성·재현성·법적 명료성 사전 확보"
```
`O / ○ / ✓` → 오렌지 bold, `X / × / ✗` → muted.

### `kpi` — 큰 숫자 카드 (3-4개)
```yaml
- layout: kpi
  title: "핵심 KPI"
  takeaway: "운영팀 채택 기준 85% 달성"
  items:
    - { value: "+50%",  label: "AI 답변 채택률", desc: "기존 대비 (G2)" }
    - { value: "85%",   label: "500 QA 정확도",  desc: "운영팀 채택 기준" }
  caption: "* 응답 지연 평균 약 3분"
```
value 길이에 따라 자동 폰트 축소 (≤5자 64pt / ≤8자 48pt / 그 이상 36pt).

### `feature_grid` — 2x2 (또는 2x3) 카드
```yaml
- layout: feature_grid
  title: "핵심 컴포넌트"
  takeaway: "Brain Store + Comment Agent 두 축"
  items:
    - { num: "1", title: "Brain Store", desc: "주제별 완결 마크다운" }
```
`num` 대신 `icon` (emoji) 사용 가능. emoji 는 LibreOffice 렌더 시 fallback 주의.

### `timeline` — 가로 단계 (3-5개)
```yaml
- layout: timeline
  title: "12주 단계"
  items:
    - { phase: "W1~W2", title: "카테고리화", desc: "..." }
```

### `split` — 3단 분할 (좌 KPI / 중 본문 / 우 인사이트)  ★ 한국 컨설팅 정수
```yaml
- layout: split
  title: "한 화면 정수"
  takeaway: "..."
  left:
    label: "Auto-Loop"
    value: "1,000"
    desc: "Draft → 자가 검증 → 재작성"
  center:
    bullets:
      - "각 .md 파일 하나만 읽어도 전문가 수준"
      - "..."
  right:
    title: "KEY POINT"
    body: "기존 RAG 가 런타임에 원본을 만지작거리는 동안..."
```
좌 = 다크 패널 + 큰 숫자, 중 = 본문 불릿, 우 = 회색 패널 인사이트. 한투/PwC 톤의 정수.

### `closing` — 마무리 + 연락처
```yaml
- layout: closing
  title: "다음 단계"
  bullets: [...]
  contact:
    name: "김예시 · EXAMPLE ORG"
    email: "jules@example.com"
```

---

## 한국식 Chrome 동작 정책

자동 적용되는 layout: `bullets / comparison / kpi / feature_grid / timeline / split / toc`
자동 미적용 layout (자체 컴포지션): `title / cover_short / section / closing`

### 헤더 바 (상단 0.4")
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLE ORG     샘플 제안 · 01. 왜 지금      샘플
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 푸터 바 (하단 7.0")
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
* 자료: EXAMPLE ORG · proposal.md v1.0            05 / 15
```

### Takeaway (제목 바로 아래)
```
▶ 낮은 채택률의 근본 원인 = 4가지 메커니즘   ← 오렌지 bold
```

### Insight 콜아웃 (하단 6.10")
```
┃결론    MBS 는 증류 시점에 모두 해소 후 런타임에 올린다
```

---

## 자주 가는 함정

1. **bullet_char "▶" 비추** — Arial fallback 에서 빈 글자 렌더. `●` 또는 `•` 권장.
2. **takeaway 한 줄** — 80자 넘으면 줄바꿈. 짧을수록 강함.
3. **insight 한 줄** — 70자 이내. 두 줄 콘텐츠는 본문에.
4. **kpi value 5자 이내** — "약 5권" 보다 "5권" 짧게. 자동 축소도 있지만 수동 단축 권장.
5. **chapter_idx 0-based** — `meta.chapters` 의 첫 번째가 0.
6. **confidential 옵션** — 외부 미팅 자료에 "대외비" 표시. 명시 안 하면 빈칸 (헤더에 안 그림).
7. **source vs source_default** — 슬라이드별 `source` > 전역 `source_default`. 둘 다 미지정 시 footer 좌측 빈칸.

---

## v0.4 후보 (다음 라운드)

- 사용자 본인 `.pptx` 마스터 추출 → layout 매핑 자동 학습
- chart layout (막대/파이/꺾은선)
- image_full layout (배경 이미지 + 카피)
- vision review loop 통합 (자동 텍스트 overflow 진단/수정)
- TOC 페이지 번호 자동 채움 (현재는 yaml 에 명시)
- Pretendard 폰트 시스템 통합 (offer-A4-html 디자인 시스템 공유)
