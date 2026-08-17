# Decisions

- 하나의 surface에서 `내 파일 / 채널 / AI 팀원`을 전환하지만 storage DTO와 ACL은 합치지 않는다.
- drag payload는 versioned opaque source ref만 담는다.
- destination과 공개 범위는 server-authored plan이 결정한다.
- drag와 모바일 action menu는 같은 `transferFile()` 흐름을 사용한다.
- 기존 Project-only `FilesWorkspace`를 다중 저장소 조건문으로 확장하지 않는다.
