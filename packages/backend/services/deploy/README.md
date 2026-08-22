# services/deploy — 배포 / 샌드박스 / 인프라

Tower의 **배포·실행 인프라** 모듈. 코드 배포(Cloudflare Pages/Azure Container Apps), AI 격리 실행, 로컬 실행 격리, 선택적 조직 control-plane DNS/Fleet 운영을 포함합니다. 일반 self-host의 기본 프로필은 `standalone`이며 Fleet registry를 요구하지 않습니다.

## 책임

- **코드 배포** — 정적 (Cloudflare Pages) / 동적 (Azure Container Apps) 자동 감지·배포 (deploy-engine)
- **Fleet 관리** — `full` 조직 control plane에서만 등록 노드의 상태와 workspace를 점검(fleet-manager)
- **Execution Sandbox** — AI tool call (`sandbox.run`) 을 격리 VM 에서 실행, 결과 회수 (sandbox)
- **SSH 게이트** — sandbox VM 으로 명령 전송·검증 (sandbox-ssh)
- **bwrap 로컬 격리** — Linux 의 bubblewrap 기반 프로세스 격리 (Claude SDK 의 sandbox wrapper)
- **Cloudflare DNS** — 자체 호스팅 서버 의 wildcard subdomain 자동 생성·삭제

## Public API

### `deploy-engine.ts` — 코드 배포 (가장 큰 파일, 38KB)
- `deploy(opts)` — 메인 entry. target 자동 라우팅
- `detectCodeType(sourceDir)` — `'static' | 'dynamic'` (Dockerfile / package.json 분석)
- `deleteDeployment(opts)` — 배포 제거
- `updateManifestAfterDeploy` — `published/manifest.json` 갱신 (publish-client 가 호출)
- `normalizeAppName` — slug 검증 (`a-z0-9-`)
- 타입: `DeployTarget` (`'local' | 'cloudflare-pages' | 'azure-container-apps'`), `DeployStatus`, `Access` (`'public' | 'unlisted' | 'private' | 'internal'`)

### `fleet-manager.ts` — 선택적 조직 control-plane 운영
- `getCustomers()` / `getCustomer(name)` — `TOWER_FLEET_REGISTRY_PATH`로 지정한 deployment-local registry 파싱
- `getFleetStatus()` / `getVMStatus(info)` — VM up/down + version
- `checkWorkspace(info)` — workspace 무결성 (skill 파일, decision 디렉토리 등)
- `/fleet` 스킬이 호출하는 진입점

### `sandbox.ts` — Execution Sandbox (AI tool)
- `sandboxRun(req)` — Claude/Pi 의 `sandbox.run` MCP tool 백엔드
- 4계층 토글: 서버 .env / VM 도달성 / 사용자 권한 / 세션
- `SandboxDeniedError` — 비활성 사용자 가드
- 타입: `SandboxRuntime` (`'python' | 'python-data' | 'node' | 'node-utils' | 'bash'`)
- 결과 파일은 `~/.sandbox/runs/<id>/` 로 회수 (Mode B)

### `sandbox-ssh.ts` — SSH 게이트
- `sshExec(opts)` — sandbox VM 으로 명령 전송 (key-based auth, timeout)
- `verifySandboxConnectivity()` — 부팅 검증
- `initSandbox()` — index.ts 가 부팅 시 호출, sandbox 토글 결정

### `bwrap-sandbox.ts` — 로컬 bwrap 래퍼 (Claude SDK 용)
- `createBwrapWrapper(...)` — Claude tool 실행을 bubblewrap 로 감쌈
- `isBwrapAvailable()` — Linux + bwrap binary 검증
- `shouldUseSandbox()` — config 기반 결정
- claude-sdk 가 호출 (Tower 자체 보안)

### `cloudflare-dns.ts` — DNS 관리
- `getZoneId()` / `listDnsRecords()` / `createDnsRecord` / `deleteDnsRecord`
- `createWildcardForCustomer(name)` — self-hosted VM 도입 시 `*.<customer>.tower.example.com` 자동 추가
- `getCustomerDnsStatus(name)` — DNS 설정 검증

## 들어오기 전에 알아야 할 것

- **배포 vs sandbox 구분**: deploy-engine 은 *영구* 배포 (사이트 / 서버), sandbox 는 *일회성* AI 실행. 둘 다 격리 환경이지만 lifecycle 다름.
- **sandbox 4계층 토글**: AI tool 호출 시 4단계 검증 (서버 / 호스트 / 사용자 / 세션). 한 단계라도 false → 도구 안 보임.
- **Fleet는 일반 self-host 기능이 아님**: `full` profile 운영자가 별도 registry와 승인된 배포 자동화를 구성한 경우에만 사용합니다.
- **deploy-engine 38KB monolithic**: 정적/동적 라우팅 + Cloudflare API + Azure ACR API + 빌드 파이프라인이 한 파일. 배포 흐름이 한 곳에 응집 → AI 가 디버그 시 한 파일만 읽으면 됨. 분리 후보였지만 응집 깨짐.
- **bwrap 는 Linux only**: macOS / Windows dev 에선 사용 안 함. `isBwrapAvailable()` 가 false 면 Claude SDK 가 unwrapped 실행.
- **Cloudflare API 는 admin token 필요**: `.env` 의 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`. 없으면 cloudflare-dns 비활성.
- **self-hosted VM 도 sandbox 가능**: Phase 5 부터 (D12). 자기 형제 execution VM 이 있으면 활성. 없으면 자연스럽게 비활성.
- **publish-client와 deploy-engine 차이**: publish-client는 명시적으로 설정된 *managed* 노드가 조직의 *full* publish gateway로 콘텐츠를 전송합니다. `standalone`은 gateway에 의존하지 않고 자기 provider를 직접 사용합니다.

## 관련 결정문서

- `workspace/decisions/2026-04-23-publishing-visibility-redesign.md` — Access 정책 (public/unlisted/private/internal)
- `workspace/decisions/2026-04-24-execution-sandbox-scope.md` — Sandbox D6, D7
- `workspace/decisions/2026-05-01-fleet-mandatory-entry-point.md` — `/fleet` 룰
- `workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md` — D12 sandbox 모든 VM 에서 활성
- `workspace/decisions/2026-05-02-execution-sandbox-d13-aca-deprecation.md` — ACA 외 sandbox 가 default
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/auth/credential-store` — Claude account rotation (sandbox 환경 변수 일부 영향)
- `services/claude-sdk` — `bwrap-sandbox` 를 wrapper 로 사용
- `services/publish-client` — 설정된 managed 노드가 조직 gateway를 호출(deploy-engine의 manifest 갱신 함수 사용)
- `mcp/sandbox-server` — Claude 의 in-process MCP server, sandbox.ts 위임
- `routes/gateway.ts` — full VM 의 publish gateway (deploy-engine + cloudflare-dns 호출)
- `routes/api.ts` — admin 의 fleet / deployment REST 엔드포인트

## 테스트

- 단위 테스트 없음 (외부 API + SSH + Cloudflare 의존성 큼). 통합 테스트로 대체.
