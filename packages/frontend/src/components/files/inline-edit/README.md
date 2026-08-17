# inline-edit (frontend)

File preview 위에 얹는 인라인 AI 편집 surface.

## 책임

- 사용자가 미리보기 안에서 텍스트를 드래그하면 floating bar 표시
- bar 의 입력창에 자연어 지시 → backend `/api/files/inline-edit` 호출
- 응답을 diff 미리보기로 띄움 → 사용자 "적용" → `/api/files/write` 로 커밋

## Public API

```tsx
import { useInlineEdit } from './inline-edit/useInlineEdit';
import { SelectionBar } from './inline-edit/SelectionBar';
import { DiffPreview } from './inline-edit/DiffPreview';

function MyPreview({ content, filePath, onContentChange }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineEdit = useInlineEdit({ content, filePath, containerRef, onContentChange });

  return (
    <div ref={containerRef}>
      {/* preview content (ReactMarkdown / iframe / etc.) */}
      <SelectionBar state={inlineEdit} />
      <DiffPreview state={inlineEdit} />
    </div>
  );
}
```

## 들어오기 전 알아야 할 것

- **selection → raw text 매핑은 휴리스틱.** ReactMarkdown 이 markdown 을 HTML 로
  바꾸면서 `*bold*` 가 `<strong>bold</strong>` 가 됨 → selection.toString() 은
  "bold" 인데 raw 엔 "*bold*". 다중 매치는 앞뒤 컨텍스트로 좁히고, 그래도
  애매하면 사용자에게 알림 + 더 큰 영역 선택 유도.
- **iframe 안 selection 은 캐치 안 됨.** HtmlPreview 같은 sandbox iframe 은
  Phase 1 에서 제외. md preview 만 우선 지원.
- **mtime drift.** backend 가 응답에 mtimeMs 를 실어줌. 사용자가 적용 클릭할 때
  최신 read 의 mtime 과 비교 — 다르면 경고.
- **state machine.** idle → loading → preview → applied | cancelled | error.
  loading 중 새 selection 막기, preview 중 esc/취소 → idle.

## 관련 결정

- `workspace/decisions/2026-05-05-preview-inline-edit.md`
