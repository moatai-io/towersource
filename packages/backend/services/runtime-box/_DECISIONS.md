# Runtime Box module decisions

## 최종 구조는 Tower control plane + Worker compute plane

- Worker는 같은 머신의 Local Worker와 외부 서버의 Remote Worker를 모두 포함한다. 네트워크 위치가 아니라 Tower와 분리된 실행 주체라는 점이 핵심이다.
- `local-runtime | remote-worker` selector는 migration seam이지 영구 혼합 architecture가 아니다. 정상 제품 경로는 Project default Worker로 수렴한다.
- 사용자가 Local/Remote provider를 선택하지 않는다. scheduler가 Project scope, capability, liveness, drain, capacity에 따라 Worker를 고른다.
- foreground와 Durable Job은 장기적으로 하나의 Remote Run primitive를 공유한다. 차이는 streaming·disconnect·durability policy다.
- Local Runtime fallback은 개발·명시적 비상복구 외에는 조용히 일어나면 안 된다. 현재 단일 env fallback은 전환기 호환 코드다.
- 근거: `workspace/decisions/2026-08-10-tower-control-plane-only-project-compute.md`.

## Worker identity와 execution transport authority는 분리

- Worker identity JWT는 Worker→Tower `register`·`heartbeat` 권한이다. `workerId`, Project allowlist, capability ceiling, audience, subject, expiry에 묶인다.
- 발급 시 JWT 원문은 admin 응답에 한 번만 반환한다. DB에는 `jti`, scope, 만료, 발급자, 회수·교체 이력만 남긴다.
- register·heartbeat는 서명/만료 검증 뒤 DB의 exact `jti`가 active인지 다시 확인한다. DB 확인 실패·미등록·회수 상태는 fail-closed한다.
- execution transport token은 Tower→Worker `/v1/runs` 권한이다. 둘은 방향과 위협 모델이 달라 같은 token으로 합치지 않는다.
- PostgreSQL Worker registry에는 token·Credential 값을 저장하지 않는다. scheduling에 필요한 비민감 metadata만 저장한다.
- heartbeat는 identity, endpoint, Project scope, capability, drain을 수정하지 못한다. capacity와 liveness만 갱신한다.
- DB row가 있다고 실행 권한이 생기지 않는다. 선택된 Worker의 transport 인증 material을 별도로 해석해야 한다.

## Deployment-scoped Worker binding과 explicit Runtime Box

- Compute binding은 `(project_id, deployment_id)` 단위다. Development·Production은 같은 Project라도 다른 Worker와 rollout 상태를 가질 수 있다.
- Workstation Project는 sticky default Worker를 사용한다. 다른 eligible Worker나 Runtime Box로 조용히 이동하지 않는다.
- foreground·Durable Job·Service 모두 Worker provider 경로가 구현돼 있다. 남은 문제는 Prod canary acceptance, Service 전용 resource budget·desired-state recovery, Worker-loss slot reconcile이다.
- transient foreground·Job은 DB에서 `active_runs/max_runs` 슬롯을 원자적으로 예약·반환한다. 첫 Production canary는 `maxRuns=1`로 시작한다.
- binding이 없는 deployment만 migration 기간 동안 Runtime Box compatibility를 유지한다.
- Worker unavailable·capacity full·transport auth unavailable이면 활성 Workstation의 `bash`는 fail-closed한다. 실행 plane을 Runtime Box로 자동 전환하지 않는다.
- AI-facing Project shell은 `bash` 하나다. Project Runtime 세션에서는 native host bash를 조립하지 않으며, authority와 deployment binding이 실제 executor를 결정한다.
- Runtime Box는 일반 AI-selectable shell에서 제거한다. 격리·clean·release 실행은 후속 Sandbox execution mode로 명시적으로 라우팅한다.
- Project emergency fallback은 preview/apply와 binding snapshot·audit를 거쳐야 한다.

## Worker-local Project workspace가 storage authority다

- Workstation Project의 file API는 Tower ACL 확인 뒤 Worker-local workspace에서 read/write/mkdir/delete/rename/copy, binary I/O, multipart upload를 수행한다.
- Tower host copy는 Search·Notes Index·Knowledge Graph 같은 legacy derived read model을 위한 mirror/cache이며 정본이 아니다.
- Worker mutation 뒤 host derived mirror를 갱신한다. bounded reconcile은 정본 복구가 아니라 derived mirror repair다.
- **Migration-only:** per-Job full-project rsync는 binding 없는 Project, 초기 bootstrap, Worker 교체, backup/restore에만 사용한다. 신규 foreground·Service 기능을 rsync 전제에 맞춰 설계하지 않는다.
- 남은 storage 과제는 bootstrap·backup 운영, Worker 교체 acceptance, multi-Agent write lease다.

## Run-scoped Credential은 GWS pilot을 통과했고 범용 최소 선택이 다음 gate다

- Job+Project scope, TTL, one-time consumption, Worker key exact-match, stdout/stderr·terminal redaction을 제공한다.
- 기존 Project/user Vault policy와 risky-command suppression을 재사용한다.
- GWS는 선택된 Connection 하나를 run-scoped payload로 materialize해 실제 Worker provider auth/read와 `.tower-run-credentials/gws-*` cleanup을 검증했다.
- 범용 API-key/provider에는 **Job 요구 key ∩ Project/user 허용 key** explicit required-key 계약이 필요하다. broad Project Credential set을 Worker에 전달하지 않는다.
- 일반 파일형 Credential과 CLI login bundle은 별도 ephemeral delivery·cleanup 계약 전까지 fail-closed한다.
- crash/kill 중 cleanup black-box acceptance와 provider별 coverage가 끝나기 전 범용 Credential Broker 완료로 보지 않는다.

## 사용자별 한도 도달 시 안전한 idle LRU 회수

- 사용자 슬롯은 `project_runtime_boxes.created_by` 기준이다. 프로젝트 멤버십이나 현재 요청자의 다른 식별자로 대체하지 않는다.
- 회수는 기존 idle-stop 정책의 **조기 실행이 아니라, cron이 아직 처리하지 못한 이미 만료된 Box를 즉시 처리하는 것**이다. `last_active_at + idle_stop_minutes <= now()`인 Box만 후보가 된다.
- 후보는 같은 사용자, `running`, 현재 시작하려는 target 제외, `pending`/`running` 서비스 0개여야 한다. `starting`, 최근 활동, 활동 시각 미기록, active service가 있는 Box는 보수적으로 제외한다.
- 회수는 반드시 `stopBox(id, 'idle_stopped')`를 사용한다. 그래야 Docker 컨테이너와 서비스 registry가 같은 lifecycle로 정리되고 프로젝트 bind-mount 파일은 보존된다.
- 모든 start는 global advisory lock으로 직렬화해 전역 한도를 지키고, 이어서 같은 사용자의 start/reclaim은 user advisory lock으로 직렬화한다. lock 순서는 항상 global → user다. 회수 뒤 count를 다시 확인해 동일 후보 이중 회수와 per-user 초과 시작도 막는다.
- 각 Box의 exec와 reclaim은 activity advisory lock으로 상호 배제한다. 회수 후보를 찾은 뒤 lock 안에서 조건을 재조회해야, 후보 조회 직후 시작된 명령을 idle reclaim이 중간 종료하는 TOCTOU 경쟁을 막을 수 있다.
- 회수할 수 없으면 한도 숫자만 보여주지 않는다. 현재 사용자가 점유한 프로젝트명, 마지막 활동, 남은 idle 시간 또는 보호 이유, 해결 방법을 보여준다. 다른 사용자의 점유 정보는 노출하지 않는다.
- `service_list`의 서비스 0개는 Box가 정지했다는 뜻이 아니다. 컨테이너 warm 상태와 서비스 registry는 별도 개념임을 사용자 메시지에서 명시한다.
