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
- `session://attachments/<id>`의 도구 분석은 현재 계정 상태와 해당 세션의 읽기 ACL을 검사한 뒤 같은 세션의 첨부만 해석한다. 공유 세션의 승인된 독자도 읽을 수 있으며 URI만으로 다른 세션의 첨부를 읽을 수는 없다. 삭제·개인 공간 복사는 업로더 계약을 유지한다. Project 저장은 세션 쓰기 권한과 목적지 Project 권한을 추가로 검사한다.
- 업로드만으로 프로젝트 파일을 만들지 않는다.
- promotion은 복사이며 원본을 덮어쓰지 않는다.
- 세션 메모리 카드 정책은 이 모듈이 변경하지 않는다.

## 채팅 업로드와 명시적 저장

- 채팅 업로드는 세션 콘텐츠 작성 권한으로 허용하며 프로젝트 파일 쓰기 권한을 요구하지 않는다.
- HTTP 열람은 세션 읽기 권한을 먼저 검사한다. 삭제·promotion은 세션 작성 권한과 첨부 소유자를 검사한다.
- 프로젝트 promotion은 `project-attachment-upload.ts`를 통해 프로젝트 쓰기 권한과 Worker 저장 권위를 유지한다. Worker 오류 시 호스트로 대신 저장하지 않는다.
- 새 첨부는 기존 DB 기본값인 7일 만료를 사용한다. 만료 후 resolve는 거부되며 영구 보관은 명시적 저장이 필요하다. 기존 프로젝트 파일은 변경하지 않는다.
- 만료 파일의 물리 삭제 함수는 존재하지만 주기 실행 연결은 별도 운영 과제다. 이번 변경은 자동 삭제 작업을 새로 등록하지 않는다.

## 임시 첨부 분석 계약

- PDF는 원래 `session://attachments/…` URI를 `pdf_view`에 전달한다. Project root 밖 임시 host 경로를 재입력하지 않는다.
- HWP/DOCX 등의 `document_parse`도 같은 URI를 공통 representation gateway에 전달한다. 원본은 영구 저장하지 않으며, 요청한 Markdown 결과만 현재 Project authority로 exclusive 저장한다.
- 임시 첨부의 유효 기간·세션 ACL 검사는 저장소 경계에서 수행한다. 임의 host 경로·ACL 완화·읽기 요청의 자동 Project 저장은 허용하지 않는다.
- 업로드 파일명은 NFC 정규화 후 확장자를 보존하며 UTF-8 240바이트로 제한한다. API는 파일명 길이·디스크 부족·권한 실패를 구분하되 내부 경로를 노출하지 않는다.
- 회귀: `session-attachment-store.test.ts`, `../content-safety/file-representation-gateway.test.ts`, `../../engines/pi-pdf-view-tool.project-staging.test.ts`, `../../engines/pi-document-parse-tool.test.ts`, `../../routes/session-attachment-upload.test.ts`.

## 비공개 대화와 공용 저장소의 경계

- 세션 첨부는 uploader/session별 임시 저장소에 남는다. 읽기·쓰기 API는 현재 세션 audience를 검사하며 private는 owner-only 정책을 따른다. 운영 role은 private 콘텐츠 접근권을 자동으로 얻지 않는다.
- private 첨부도 소유자가 명시적으로 Project `uploads/`에 저장할 수 있다. 저장한 파일은 에이전트 구성원에게 공유되며 대화 private 전환으로 파일을 회수하지 않는다.
- artifact fence, Markdown create/update, document_parse, PDF export, Excel write, publish는 대화 visibility와 무관하게 기존 파일·실행·외부 게시 권한을 따른다. 에이전트 파일은 공유 영역이다. 세션 연결 helper는 존재하는 세션인지 확인한다.
- 최근 Project 파일 fallback은 source session audience를 집계·LIMIT 전에 적용한다. private parent에서 만든 spawn child는 private visibility를 상속한다.
- 회귀 검증: `session-attachment-store.test.ts`, `../session/session-artifact-privacy.test.ts`, `../session/session-file-access.test.ts`, `../session/spawn-rpc.source.test.ts`, `../workspace/assistant-artifact-blocks.test.ts`, `../../engines/private-artifact-tools.test.ts`, `../../engines/pi-markdown-artifact-tool.test.ts`, `../../engines/pi-document-parse-tool.test.ts`.

이는 application 수준의 경계이지 OS 격리가 아니다. 같은 UID의 shell·일반 파일 도구가 공유 cwd나 다른 사용자의 물리 파일을 접근하는 위험은 별도 실행 격리 없이는 제거되지 않는다. 공유 디렉터리에 이미 있는 콘텐츠도 private provenance를 복원할 수 없다. Claude native auto-memory는 SDK에서 비활성화되지만 임의 shell/manual memory write는 같은 잔여 위험을 가진다.

이 검증은 로컬 코드·fixture 결과이다. 운영 PDF 렌더링·Corepin 인증 및 실제 배포는 별도 검증이다. 최초 첨부 요청의 무출력 종료는 당시 서버 shutdown과 DB pool 종료가 겹쳤으므로 첨부 분석 차단과 분리해 lifecycle에서 조사한다.
