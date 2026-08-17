# deploy 모듈 — 구조 결정

## 왜 6 파일이 한 폴더에 묶였나

*외부 배포* (deploy-engine, cloudflare-dns), *self-hosted VM 운영* (fleet-manager), *AI 격리 실행* (sandbox, sandbox-ssh, bwrap-sandbox) — 모두 "코드를 어딘가에서 실행시키는 인프라" 도메인. 묶으면 AI 가 "배포·실행 환경 작업" 받았을 때 한 폴더에서 끝.

다양해 보이지만 공통점:
- 외부 시스템 호출 (Cloudflare API, Azure CLI, SSH)
- 격리·보안이 중심 관심사
- 운영 환경에 따라 활성/비활성 (`.env` 기반 토글)

## 왜 sandbox.ts 와 sandbox-ssh.ts 가 분리됐나 (한 파일로 합치면?)

- **sandbox.ts** = 비즈니스 로직 (사용자 권한, 4계층 토글, 결과 회수, AI tool API)
- **sandbox-ssh.ts** = SSH 통신 게이트 (key 관리, timeout, 명령 전송)

분리 이유:
- 테스트 시 sandbox-ssh 만 stub 가능 → sandbox 비즈니스 로직 단위 테스트 가능
- SSH layer 가 다른 backend (예: Docker socket, gRPC) 로 교체 가능 → 인터페이스 안정
- 보안 critical 한 SSH 코드는 자주 만지지 않게 격리

## 왜 deploy-engine 이 38KB 모놀리식인가

배포 흐름은 강결합:
- target 감지 → 빌드 → 업로드 → DNS 갱신 → manifest 등록 → 알림
- 중간 단계 실패 시 rollback 다중 분기
- Cloudflare / Azure 두 backend 인터페이스 차이가 한 함수 안에서 처리

분리하면:
- 매개변수 전달 폭발 (build options, credentials, manifest state)
- 한 흐름이 5+ 파일에 걸침 → AI 가 추적 시 grep 폭발

**deep module** — 외부 표면적은 좁음 (`deploy`, `detectCodeType`, `deleteDeployment`, `updateManifestAfterDeploy`), 내부는 풍부한 한 흐름.

## 왜 fleet-manager 가 deploy/ 인가 (admin/ 아니고)

`/fleet` 스킬의 핵심 기능 = **"자체 호스팅 서버 에 배포·운영"**. health check / workspace inspection 도 결국 "배포 후 검증" 흐름. 같은 SSH 게이트 (sandbox-ssh 와 같은 패턴) + 같은 인프라 도메인.

admin/ 폴더로 빠지면 admin UI / fleet UI / 관리 도구 등 *user-facing admin* 이 다 모이게 됨 — 도메인 뒤섞임. fleet 은 *인프라 운영* 이 본질이라 deploy/ 가 더 적합.

## 왜 bwrap-sandbox 가 sandbox 와 다른 파일인가

- **sandbox** = AI tool 실행 (원격 VM, 사용자 토글, 결과 회수)
- **bwrap-sandbox** = Claude SDK tool 실행 wrapper (로컬, 매 도구 호출)

다른 lifecycle, 다른 보안 모델, 다른 호출자. 둘 다 sandbox 라는 이름이지만 합치면 의미 폭발 (bwrap 은 Linux only, sandbox 는 항상 가능).

## 왜 cloudflare-dns 가 deploy 안인가

배포 흐름의 일부 — managed 자체 호스팅 서버 도입 시 `*.<customer>.tower.example.com` wildcard DNS 자동 생성. 코드 배포 시 새 슬러그 등록 등. DNS 자체가 별도 도메인 같지만 *배포의 sub-step*. 별 폴더로 빼면 호출 그래프가 deploy → dns 폴더 cross 만 발생.

향후 Route53 / Cloudflare 외 다른 DNS provider 추가 시 dns/ 분리 검토 가능. 지금은 Cloudflare 단일이라 합치는 게 응집.
