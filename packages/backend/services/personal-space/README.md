# Personal Space

사용자 소유의 개인 Markdown 노트와 파일을 프로젝트 workspace 밖에 보관한다.

## 책임

- `personal://` 가상 URI와 안전한 상대경로 변환
- `${config.dataDir}/personal-spaces/<user-id>/files` 아래 파일 저장
- `personal_files` 메타데이터와 filesystem 내용 동기화
- owner user ID를 모든 Public API의 필수 입력으로 요구

## Public API

`personal-space-store.ts`의 `ensurePersonalSpace`, `listPersonalFiles`, `createPersonalNote`, `readPersonalFile`, `writePersonalFile`, `renamePersonalFile`, `archivePersonalFile`.

## 들어오기 전 알아야 할 것

- 프로젝트 파일 API와 경로를 공유하지 않는다.
- host 절대경로는 외부에 반환하지 않는다.
- MVP는 Markdown 노트만 생성·편집한다.
- Project Runtime Box에 이 저장소를 mount하지 않는다.
