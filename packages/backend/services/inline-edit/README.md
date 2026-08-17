# inline-edit

선택된 텍스트 한 조각을 짧은 자연어 지시로 다시 쓰는 백엔드 모듈.

## 책임

- 사용자가 file preview 에서 드래그 선택한 텍스트 + 앞뒤 컨텍스트 + 지시문 → AI 가 다듬은 교체 텍스트 반환
- 모델 호출 (기본 Sonnet 4.6) 과 응답 sanitize
- 호출 이력을 `~/workspace/.audit/provenance.jsonl` 에 기록

이 모듈은 **AI 호출만** 책임진다. 권한 체크 · 파일 읽기/쓰기 · rate limit 은
라우트 레이어 (`routes/api.ts` 의 `/api/files/inline-edit`) 가 담당한다.

## Public API

```ts
import {
  runInlineEdit,
  DEFAULT_INLINE_EDIT_MODEL,
  appendInlineEditAudit,
  LIMITS,
} from './services/inline-edit/index.js';

const result = await runInlineEdit({
  selection: '선택된 텍스트',
  beforeContext: '직전 ~500자',
  afterContext: '직후 ~500자',
  instruction: '좀 더 격식 있게',
  // model: 'claude-sonnet-4-6' (default)
});
// → { replacement, raw, model, durationMs }

appendInlineEditAudit({
  sessionId, userId, role, path, instruction,
  selectionLen, replacementLen, model, applied, durationMs,
});
```

## 들어오기 전 알아야 할 것

- `runUtilityTextTask` (services/ai/utility-agent.ts) 위에 얹혀 있음. 이 helper 는
  Claude / Pi 양쪽 엔진을 추상화. 모델 ID 에 `/` 가 있으면 Pi 로 라우팅.
- 모델이 비활성이거나 네트워크 실패면 `runUtilityTextTask` 가 fallback 텍스트를
  반환. 우리는 fallback 으로 **원본 selection 자체** 를 넘김 → 사용자에게는
  "변경 없음" diff 가 보이고 hard error 가 발생하지 않음.
- 시스템 프롬프트의 핵심 제약: "선택만 교체. 컨텍스트는 절대 응답에 포함 금지.
  설명·따옴표·markdown fence 금지". 그래도 모델이 종종 fence 를 두르거나
  preamble 을 붙이는 케이스가 있어서 `sanitizeReplacement` 가 후처리.
- 입력 한도: selection 4k chars, context 1.5k chars/side, instruction 500 chars.
  초과 시 throw → 라우트가 400 으로 변환.

## 관련 결정

- `workspace/decisions/2026-05-05-preview-inline-edit.md` — Phase 1 설계 결정
- `_DECISIONS.md` — 이 모듈 안 미시 결정

## 향후

- Phase 2: xlsx 셀 단위 편집 — 같은 `runInlineEdit` 재사용 가능, 라우트 레이어만 분리
- Phase 3: pptx/docx — 별도 fuzzy-match 패턴 필요 (이 모듈 밖)
