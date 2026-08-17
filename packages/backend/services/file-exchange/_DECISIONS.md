# Decisions

- 화면은 통합하지만 Personal, Session, Channel, Project 저장소는 합치지 않는다.
- File Exchange는 policy·coordination·receipt를 소유하고 provider는 ACL·저장을 소유한다.
- inspect와 execute 사이에 source hash/version과 destination capability를 다시 확인한다.
- 공개 범위 확대 또는 영구 Project 저장은 명시적 confirmation을 요구한다.
- 기존 파일은 덮어쓰지 않고 exclusive create와 자동 rename을 사용한다.
- filesystem과 DB의 완전한 transaction을 가정하지 않고 보상 삭제 실패를 receipt에 남긴다.
- host 절대경로는 Public API와 receipt JSON reference에 저장하지 않는다.
