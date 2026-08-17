# Embedded binary and attachment representation safety

## 책임

SVG·HTML·CSS·JSON 같은 텍스트 안에 포함된 대용량 `data:*;base64,...` 또는 불투명한 base64 문자열이 AI 컨텍스트를 소모하지 않도록 모델에 전달되는 표현만 축약합니다.

업로드·프로젝트 파일은 저장 성공과 모델 입력을 분리합니다. `AttachmentRepresentationPolicy`가 작은 magic-byte/text probe로 파일을 `text | image | document | archive | opaque`로 분류하고, 모델에는 `bounded-text | vision | tool-required | reference-only` 중 하나만 허용합니다.

## Public API

- `sanitizeEmbeddedBinaryText(text)` — 원본 파일을 수정하지 않고 MIME, 인코딩 길이, 짧은 SHA-256 식별자를 남긴 placeholder로 치환합니다.
- `decideAttachmentRepresentation({ name, bytes })` — 최대 64KiB probe를 분류해 bounded model representation을 결정합니다.
- `attachmentReferenceOnlyNotice(name, decision)` — 저장은 성공했지만 자동 인라인하지 않은 파일의 안전한 설명을 만듭니다.

## 들어오기 전 알아야 할 것

- 이 모듈은 파일 저장·삭제·공유 ACL을 결정하지 않습니다.
- 실제 이미지·PDF content block은 각 전용 vision/blob 경로가 담당합니다.
- 이미지 MIME은 확장자가 아니라 magic bytes를 우선합니다.
- PDF·PPTX·DOCX·XLSX·archive는 일반 UTF-8 read로 열지 않고 전용 도구를 요구합니다.
- 임계값보다 작은 payload는 보존해 작은 fixture나 일반 코드 문자열을 과도하게 제거하지 않습니다.
- read 도구 반환과 DB 저장/재수화 양쪽에서 적용해야 오래된 tool result 재유입도 막을 수 있습니다.
- 분류가 불확실하면 파일 저장은 유지하고 모델 입력만 `reference-only`로 fail-safe 합니다.
