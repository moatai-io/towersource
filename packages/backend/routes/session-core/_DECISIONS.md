# Session Core API decisions

- 첫 slice는 lifecycle side effect가 작은 list/create/read/message read만 포함한다.
- `GET /sessions/:id`가 legacy 동적 route와 충돌하지 않도록 protected composition에서 한 번만 mount한다.
- spawn, engine, branching, archive 경로는 각각 별도 integration contract 뒤에 이동한다.
- Router는 기존 protected zone에 `/`로 mount해 URL을 보존한다.
