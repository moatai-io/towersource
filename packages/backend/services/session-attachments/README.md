# Session Attachments

## 책임

채팅에 올린 파일을 프로젝트 밖의 사용자·세션 전용 저장소에 보관하고, 사용자가 명시적으로 요청할 때만 프로젝트 또는 Personal Space로 복사한다.

## Public API

- `createSessionAttachment`
- `resolveSessionAttachment`
- `listSessionAttachments`
- `deleteSessionAttachment`
- `promoteSessionAttachmentToProject`

## 경계

- 원본은 `${TOWER_DATA_DIR}/session-attachments/<user>/<session>/...`에 저장한다.
- `session://attachments/<id>`는 같은 사용자·같은 세션에서만 해석한다.
- 업로드만으로 프로젝트 파일을 만들지 않는다.
- promotion은 복사이며 원본을 덮어쓰지 않는다.
- 세션 메모리 카드 정책은 이 모듈이 변경하지 않는다.
