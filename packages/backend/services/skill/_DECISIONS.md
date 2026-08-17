# skill 모듈 — 구조 결정

## 왜 bind-ro MVP가 Docker child mount인가

2026-07-10 결정에 따라 Runtime Box의 조직 스킬은 스킬별 read-only bind mount를 사용한다. Privileged host mount helper와 mount propagation을 만들지 않고, 프로젝트 root rw mount 뒤 manifest-listed teamskills source를 Docker child `--mount ... readonly`로 overlay한다. schema v3 manifest 자체가 desired-state gate이며 프로젝트에는 host discovery와 mount target을 위한 `SKILL.md`, `skill.yaml`, marker만 남긴다. schema v2는 명시적 copy mode로 남는다. schema v3 source 하나라도 missing/unsafe이면 불완전한 control-only 폴더로 실행하지 않고 box start를 fail-closed한다.

Copy transport의 파일당 2MB·bundle 20MB 제한은 mount safety에 적용하지 않는다. bind mount는 복사하지 않으므로 대형 이미지·reference bundle을 허용한다. secret/path escape/symlink는 차단하고 generated cache는 정본 청소 대상으로 경고하되 read-only mount는 허용한다. 스킬 실행 시 uv/Python 상태는 canonical source가 아니라 `/tmp/tower-runtime-cache` 등 writable runtime 경로를 사용한다.

## 왜 4 파일이 한 폴더에 묶였나

스킬 *DB CRUD + 파일 sync* (skill-registry), *라이브러리 인덱스* (library-skills), *슬래시 커맨드* (command-loader), *자격증명 readiness* (skill-credential) — 다 "스킬·커맨드·providers" 도메인. 묶으면 AI 가 "스킬 작업" 받았을 때 한 폴더에서 끝.

## 왜 skill-registry 와 library-skills 가 양방향 의존인가

- skill-registry → library-skills: `bootstrapLibraryProviders` 가 라이브러리 스킬을 DB 에 등록할 때 library 측 스캐너 호출
- library-skills → skill-registry: frontmatter 파싱 함수 `parseFrontmatterField` 재사용

분리하면 frontmatter 파서 중복 또는 별도 utils.ts 필요. 한 폴더로 둠 → 양방향 OK (Node 가 ESM 순환 import 처리). 외부 호출자에게는 둘이 한 단위로 보임.

## 왜 SkillInvocation Runtime 을 별도 파일로 두나

스킬 실행은 이제 단순히 `SKILL.md`를 읽는 일이 아니라 다음 책임을 함께 갖는다.

- slash / picker / natural-language 신호를 같은 객체로 정규화
- active `<active_skill>` prompt 렌더링
- user/assistant message metadata merge
- `skill_invoked` 사용자 표시 payload
- process event payload

이 책임을 `ws-handler`에 흩뿌리면 handler가 3천 줄짜리 shallow coordinator에서 더 비대해진다. 그래서 `skill-invocation.ts`를 **deep module**로 둔다. 외부는 `resolveSkillInvocationForMessage()`와 몇 개의 payload helper만 호출하고, matching/gate/metadata shape는 모듈 안에 숨긴다.

자연어 auto-trigger는 보수적 deterministic gate만 허용한다. “회의 준비해줘”처럼 의미상 비슷한 요청은 자동 발동하지 않고, “회의준비 스킬로 …”처럼 사용자가 스킬 사용 신호를 준 경우만 승격한다. 오탐을 줄이고 사용자의 예측 가능성을 우선한다.

## 왜 command-loader 와 skill-registry 가 분리됐나

- skill = SKILL.md (다단계 prompt + tool + workflow)
- command = `*.md` (단순 슬래시 명령어, 한 prompt)

같은 `~/.claude/` 디렉토리 트리 안이지만 *모델이 다름*. 합치면 SkillMeta 폭발 (command 는 frontmatter 적음, providers 없음 등). 분리 유지.

향후 `agents/` (subagent 정의) 등 추가될 때도 같은 패턴 — 한 폴더에 source-of-truth 모듈 추가.

## 왜 skill-credential 이 services/auth/ 가 아니라 여기인가

skill-credential 은 *스킬 관점* 에서 "이 스킬은 어떤 provider 가 필요한가" 를 다룸. 실제 OAuth 토큰 자체는 services/auth/oauth-manager 가 보유. skill-credential 은 *readiness 게이트* — 스킬 호출 전에 "필요한 토큰이 있나?" 만 검증.

도메인이 다름:
- auth/ = "토큰을 어떻게 저장하고 갱신하나"
- skill/skill-credential = "어떤 스킬이 어떤 토큰을 요구하나 + 사용자가 가졌나"

스킬 frontmatter 파싱 / provider 매핑이 여기 응집. auth 에 두면 skill 도메인 logic 이 auth 에 흘러감.

## 왜 DB + 파일시스템 dual source 인가 (한쪽만 쓰면 안 되나)

- **DB only**: 권한 / scope / sharing 쉬움. 하지만 SDK / Claude CLI 가 직접 못 읽음 (그쪽은 fs 만 봄).
- **fs only**: SDK 친화. 하지만 권한·scope·검색 어려움.

둘 다 — DB 는 진실 (CRUD / scope), `syncXxxToFs` 가 DB → fs 미러링. SDK 가 fs 만 보면 됨. 사용자 변경 시 DB → fs 자동 sync.

부작용: fs 직접 수정 시 DB 와 drift. admin 이 손으로 SKILL.md 편집할 때만 일어남 → "admin 만" 정책으로 제어.

## 왜 bootstrapLibraryProviders 가 부팅 시 1회 호출인가

라이브러리 스킬 (`~/.claude/skills/`) 은 시스템 제공 — 일반 사용자가 추가/삭제 안 함. 변경은 Tower 업데이트 시 발생. 매 요청마다 fs 스캔하면 비용 큼. 부팅 1회 + DB 캐시. 라이브러리 변경 시 서버 재시작.

`invalidateLibraryCache` 는 admin 이 라이브러리 수정 시 *수동* 호출 — 운영 환경에선 거의 안 쓰임.
