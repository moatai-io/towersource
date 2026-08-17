# Decisions

- Personal Space는 프로젝트의 특수 폴더가 아니라 사용자 소유 저장 범위다.
- 클라이언트와 AI에는 host path 대신 `personal://<relative-path>`만 노출한다.
- 파일 본문은 filesystem에, 소유권·버전·해시는 PostgreSQL에 둔다.
- 모든 작업은 호출자의 user ID로 저장 root와 DB owner predicate를 함께 제한한다.
- symlink와 `..`를 이용한 storage root 이탈을 차단한다.
