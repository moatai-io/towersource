# Session Core API

인증된 사용자의 Session 목록·생성·조회와 메시지 read HTTP 경계를 소유한다.

## Public API
- `session-core-router.ts`의 Express Router
- `GET/POST /sessions`
- `GET /sessions/:id`
- `GET /sessions/:id/full`
- `GET /sessions/:id/messages`

## 경계
- Session access와 Project create 권한은 `services/pm/project-access.ts`가 정본이다.
- Session persistence는 `services/session/session-manager.ts`, 메시지는 `services/message-store.ts`가 소유한다.
- process map, spawn/send, engine switch, branching/rewind, clone, archive/restore는 아직 legacy `api.ts`에 남는다.
- 기존 URL, route ordering, status와 response shape를 변경하지 않는다.
