# Runtime Box compatibility와 legacy 실행 모듈

`services/runtime-box/`는 현재 실행 도메인의 정본 폴더가 아닙니다. Docker Runtime Box compatibility, 아직 이동하지 않은 Worker/Job/Service/Credential 구현과 과거 import를 위한 re-export가 함께 남아 있는 전환 디렉터리입니다.

현재 계약은 다음 순서로 읽습니다.

1. [`docs/architecture/execution-terminology.md`](../../../../docs/architecture/execution-terminology.md)
2. [`services/project-environment/README.md`](../project-environment/README.md)
3. [`services/execution/`](../execution/)
4. [`docs/decisions/2026-09-17-worker-lite-project-environment.md`](../../../../docs/decisions/2026-09-17-worker-lite-project-environment.md)

## 이 디렉터리에 남는 책임

### Runtime Box compatibility

- Docker 기반 Project runtime lifecycle
- `project_runtime_boxes`와 관련 row·capacity·reclamation
- `/api/runtime-box`와 기존 도구 호환
- Runtime Box 전용 Credential materialization

Runtime Box는 신규 일반 Project의 기본 실행환경이나 Worker 장애의 silent fallback이 아닙니다.

### 이동 중인 legacy 구현

- Worker server와 entrypoint
- Worker identity와 transport credential
- 일부 execution selector 내부 구현
- Durable Job·Service·process lifecycle
- legacy Worker-local file authority와 derived mirror
- experimental managed Workbench tool state

이 기능들은 활성 코드일 수 있습니다. `legacy`는 삭제 가능하다는 뜻이 아니라 현재 도메인 소유권과 이름이 아님을 뜻합니다.

### Compatibility re-export

다음 종류의 파일은 새 정본을 다시 export합니다.

- Project Environment admission·workspace authority
- Worker registry·repository·HTTP transport
- execution broker·remote Job runner 등 단계적으로 이동한 모듈

새 production caller는 re-export 경로를 사용하지 않고 현재 정본을 직접 import합니다.

## 현재 소유권 지도

| 책임 | 현재 정본 | 이 폴더에서의 상태 |
|---|---|---|
| Project 권한·root·environment mode | `services/project-environment/` | deprecated alias만 유지 |
| Executor 선택·broker | `services/execution/` | 일부 historical 구현/alias 유지 |
| Worker registry·repository·HTTP transport | `services/execution/worker/` | deprecated alias 유지 |
| Canonical workspace authority | `services/project-environment/project-workspace-authority.ts` | legacy Worker file adapter는 아직 남음 |
| Docker Runtime Box | 이 디렉터리 | compatibility 구현 |
| Skill/Automation Workbench UI | 별도 frontend/service 모듈 | 이 실행 디렉터리와 다른 의미 |

## 새 코드를 추가할 때

- Project 권한, workspace authority, environment mode는 `services/project-environment/`에 둡니다.
- executor selection, command·Job·Service lifecycle은 `services/execution/`에 둡니다.
- Worker protocol·persistence·transport는 `services/execution/worker/`에 둡니다.
- Runtime Box에만 필요한 Docker compatibility 로직만 이 디렉터리에 추가합니다.
- historical DB/API/systemd 이름을 참조해야 하면 adapter나 repository에 격리합니다.
- Worker 실패를 host 또는 Runtime Box fallback으로 바꾸지 않습니다.

## 검색 alias와 외부 호환

다음 식별자는 기존 배포와 migration을 위해 남아 있습니다.

- `workbench-*`, `remote-workbench-*`
- `runtime_box_workbench_*` DB 테이블
- `/api/workbench-workers`, `/api/runtime-box`
- `workbench-worker` runtime label
- `tower-workbench-worker*` binary와 systemd unit
- `workstationMode`, `defaultWorkerId`, `runtimeBox*`

이 이름은 파일 이동과 별도로 versioned migration·alias·운영 smoke가 필요합니다. 기존 migration을 rename하거나 문자열을 일괄 치환하지 않습니다.

## Legacy 문서

과거 Worker-first, Worker-local workspace, sticky binding과 Workbench rollout 문서는 [`docs/legacy/execution/`](../../../../docs/legacy/execution/README.md)에 보존합니다. 당시 문서의 `current`, `standard`, `canonical` 표기는 현재 제품 계약이 아닙니다.

## 검증 경계

관련 단위·통합 테스트가 존재해도 다음을 자동으로 증명하지 않습니다.

- 배포된 Worker revision
- 운영 DB migration 적용 상태
- 실제 OS UID/HOME/mount 격리
- 모든 파일 API와 bash의 동일 bytes 사용
- Job·Service·Credential 종단 통합
- Runtime Box compatibility 제거 완료

현재 코드 이동 현황과 남은 위험은 [`Workbench·Runtime Box 잔존 의존성 감사`](../../../../docs/architecture/workbench-runtime-box-dependency-audit.md)를 확인합니다.

## Same-host Worker 인증 자동 갱신

- 구현: [`workbench-worker-identity-renewal.ts`](./workbench-worker-identity-renewal.ts), [`renew-local-worker-identity.ts`](../../scripts/renew-local-worker-identity.ts).
- 기존 assignment reconciler timer가 작업 유무·scope routing에 앞서 갱신을 수행합니다. 명시적인 identity 파일과 deployment exclusive lock이 필요합니다. 별도 Worker self-service API나 만료 우회는 없습니다.
- JWT와 DB 유효기간 중 짧은 쪽이 7일 이내이면 30일로 갱신합니다. 서명·Worker·Project·capability·DB 활성 상태를 확인하며, 만료·폐기·교체된 identity는 운영자 복구가 필요합니다.
- 기존 jti를 유지하므로 revocation은 갱신 전후 모든 토큰에 적용됩니다. 이는 새 identity 발급이나 scope 변경이 아닙니다. trusted same-host maintenance만 서명 권한을 사용합니다.
- 파일은 기존 소유자·모드를 유지해 원자적으로 교체합니다. DB와 파일 중 한쪽만 갱신된 경우 다음 tick에서 재검사합니다. heartbeat는 매 요청 파일을 다시 읽으므로 서비스 재시작이 필요하지 않습니다.
- 배포가 공유 잠금을 유지한 채 reconciler를 동기 실행할 수 있으므로, 갱신의 배타 잠금은 nonblocking으로 시도합니다. 잠금 경합만 `deployment-lock-busy`로 기록하고 다음 timer tick으로 갱신을 미룹니다. assignment는 이후 기존 공유 잠금 검사를 그대로 통과해야 하므로 배타 maintenance 중 실행되지 않습니다. 배포가 오래 걸려 identity가 만료된 경우에는 복구하지 않으며, 다른 실행 경로의 신원 검증도 유지합니다. 잠금을 얻은 뒤의 실제 갱신 오류는 exit 75를 포함해 실패로 처리합니다.
- 잠금 경합 외의 갱신 실패는 timer 실행을 실패시키고 값 없는 `WORKER_IDENTITY_RENEWAL_FAILED` 로그를 남깁니다. 외부 알림 전송은 포함하지 않습니다. timer 자체가 장기간 중단되어 만료된 경우 자동 복구하지 않습니다.
- 잠금 회귀: `python3 scripts/nix-app/assignment-renewal-lock.test.py`는 실제 launcher와 임시 flock을 사용해 공유 배포 잠금 중 진행, 다음 tick 갱신, 배타 maintenance 차단, 갱신 오류와 누락 잠금의 실패를 검사합니다. node 작업만 합성하며 설치 서버를 변경하지 않습니다.
- 회귀: [`workbench-worker-identity-renewal.test.ts`](./workbench-worker-identity-renewal.test.ts), [`local-workbench-worker-heartbeat.test.ts`](../../scripts/local-workbench-worker-heartbeat.test.ts). 로컬 시험은 운영 배포·브라우저 E2E 근거가 아닙니다.
