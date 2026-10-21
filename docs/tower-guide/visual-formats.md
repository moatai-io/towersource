# Dynamic Visual 포맷 전체 목록

Tower 채팅에서 코드블록으로 출력하면 자동 렌더링되는 포맷.

**현재 생성 지침과 과거 렌더러는 다릅니다.** `approval`, `form`, `kanban`은 과거 세션 호환 렌더러가 남아 있지만 신규 작성 권고가 아닙니다. `secure-input`도 파서·렌더러에는 남아 있으나 자격증명 입력은 현재 도구 기반 흐름을 따릅니다. 아래 표는 지원되는 렌더 형식의 목록이지 모든 형식을 새로 생성하라는 뜻은 아닙니다.

## 기본 포맷 (7종)

시스템 프롬프트(`system-prompt.ts`)에서 모든 세션에 자동 주입.

| 포맷 | 코드블록 | 용도 | JSON 스키마 |
|------|---------|------|------------|
| 차트 | `chart` | 숫자 데이터 비교. 카테고리 비교는 bar/table, 시간 추이는 line/area, 구성비는 stacked bar 우선·pie는 3–5개 구성비일 때만 | `{ "type": "bar\|line\|area\|pie\|scatter\|radar\|composed", "data": [...], "xKey", "yKey" }` |
| 다이어그램 | `mermaid` | 프로세스, 아키텍처, 관계 | Mermaid 문법 (flowchart, sequence, class, ER, gantt, state, pie, mindmap) — 노드 레이블에 `()` `:` `,` `#` `"`가 포함되면 반드시 `"..."`로 감싸기 (e.g. `A["Process (async)"]`). 미감싸면 파서 중단 → `codify.md` 2026-04-18 참고 |
| 데이터 테이블 | `datatable` | 구조화 비교, 행렬 | `{ "columns": [...], "data": [[...]] }` |
| 타임라인 | `timeline` | 로드맵, 일정 | `{ "items": [{ "date", "title", "status" }] }` |
| 수식 | `$$...$$` | LaTeX 블록 수식 | 인라인 `$` 비활성 (달러 충돌 방지) |
| HTML 샌드박스 | `html-sandbox` | 인터랙티브 데모, 프로토타입 | HTML/CSS/JS 직접 입력 (iframe sandbox) |
| SVG | `svg` | 정적/애니메이션 인포그래픽, 히어로 이미지, 브랜디드 도식 | Raw SVG (`<svg ...>`). DOMPurify(svg+svgFilters) 통과. iframe 없이 인라인 렌더 — `html-sandbox`보다 가벼움 |
| 지도 | `map` | 위치, 경로, 영역 | Leaflet 기반 마커/폴리곤 |

## 확장 렌더 형식

과거 호환 형식을 포함한 렌더러 목록입니다. 신규 생성 지침은 [시각화 runtime guide](resources/visualization.md)를 우선 확인합니다.

| 포맷 | 코드블록 | 용도 | JSON 스키마 |
|------|---------|------|------------|
| 보안 입력 (과거 호환) | `secure-input` | 렌더러는 남아 있으나 신규 자격증명 수집에 사용하지 않습니다. 현재는 동의를 받은 뒤 `credential_vault_input` 도구를 사용하며 `.env` 입력 블록을 생성하지 않습니다. | 과거 메시지 렌더링용 |
| 스텝 가이드 | `steps` | 진행 상태 | `{ "steps": [{ "title", "status" }], "current": N }` |
| 코드 비교 | `diff` | Before/After | `{ "before", "after", "mode": "split" }` |
| 터미널 | `terminal` | 명령 결과 | `{ "commands": [{ "cmd", "output", "status" }] }` |
| 비교 카드 | `comparison` | 옵션 비교 | `{ "items": [{ "name", "pros", "cons", "score" }] }` |
| 트리맵 | `treemap` | 계층 데이터 | `{ "data": [{ "name", "value", "children" }] }` |
| 갤러리 | `gallery` | 이미지 모음 | `{ "images": [{ "src", "caption" }], "columns": N }` |
| 오디오 | `audio` | 오디오 재생 | `{ "src", "title" }` |

## 과거 호환 포맷 (신규 생성 제외)

아래 3종은 시스템 프롬프트에서 제거됐고, AI 는 새로 생성하지 않습니다. 과거 세션의 기존 블록은 여전히 렌더됩니다 (버튼이 AI 신호를 보내지 않는 알려진 제약).

| 포맷 | 코드블록 | 대체 방법 |
|------|---------|----------|
| 폼 | `form` | 비밀이 아닌 질문은 현재 AskUserQuestion 또는 일반 대화로 처리 |
| 칸반 | `kanban` | `steps` 또는 `datatable` 로 상태 표시. 진짜 태스크 보드는 Agent Board(`/kanban`) 사용 |
| 승인 위젯 | `approval` | 즉시 승인 요청은 명시적인 승인/취소 선택지를 가진 AskUserQuestion으로 처리 |

과거 결정 맥락은 접근 통제된 decision archive에 보존합니다. 공개 문서는 별도 Project의 private 경로를 참조하지 않습니다.

## 렌더링 인프라

- **파서**: `shared/split-dynamic-blocks.ts` — 코드블록 감지 + 분리
- **라우터**: `shared/RichContent.tsx` — 블록별 컴포넌트 매핑
- **컴포넌트**: `components/chat/*Block.tsx` — 개별 렌더러
- **코드 스플릿**: `React.lazy` — 미사용 포맷은 로드 안 됨
- **실시간**: 코드블록 닫히면 스트리밍 중에도 즉시 렌더
- **폴백**: JSON 파싱 실패 시 원본 코드블록 표시

## 새 포맷 추가 절차

→ `update-map.md` "시각화 포맷 추가 체크리스트" 참조

### ⚠️ 함께 수정해야 하는 위치 (drift 방지)

새 포맷을 추가하거나 기존 포맷의 필드명을 바꿀 때, 아래 위치들은 **반드시 같은 PR에서 함께** 갱신합니다. 한쪽만 고치면 AI가 새 포맷을 모르거나(프롬프트 누락) 렌더링이 실패(파서/컴포넌트 누락)합니다.

1. `packages/backend/services/system-prompt.ts` → `buildCoreSystemPrompt()`의 Visualization 섹션에 스키마 + 예시 추가
2. `packages/frontend/src/components/shared/split-dynamic-blocks.ts` → 파서에 블록 타입 감지 추가
3. `packages/frontend/src/components/shared/RichContent.tsx` → 타입 → 컴포넌트 매핑 (React.lazy)
4. `packages/frontend/src/components/chat/*Block.tsx` → 렌더러 구현
5. 이 문서(`docs/tower-guide/visual-formats.md`) → 상단 카탈로그 표 갱신

**자주 실수하는 지점**
- 시스템 프롬프트(1번)만 추가하면 AI가 출력은 하지만 렌더가 안 됨 → 원본 코드블록으로 노출.
- 렌더러(2~4번)만 추가하면 AI가 새 포맷을 알지 못해 거의 사용하지 않음.
- 필드명 변경(예: `rows` → `data`) 시 1번과 2번을 동시에 바꿔야 기존 세션 호환이 유지됨.
- 시각 톤 변경(예: chart 기본 팔레트, Mermaid theme) 시 runtime guide와 도움말 예시도 함께 갱신해 AI가 무지개색 custom chart를 기본값처럼 생성하지 않게 합니다.
