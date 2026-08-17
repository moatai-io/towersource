# pm 모듈 — 구조 결정

## 왜 4 파일이 한 폴더에 묶였나

프로젝트 *CRUD* (project-manager), *접근 제어* (project-access), *AI 컨텍스트* (pm-feed-context), *인박스* (inbox) — 모두 "프로젝트 관리" 도메인. 묶으면 AI 가 "프로젝트 / 권한 / PM 작업" 받았을 때 한 폴더에서 끝.

## 왜 `pm-inbox/` 가 사라지고 `pm/` 로 합쳤나

- 이전: `services/pm-inbox/inbox.ts` (1 파일 폴더)
- 지금: `services/pm/inbox.ts` (4 파일 폴더)

1 파일 폴더는 deep module 정신과 어긋남 — 외부 표면적 vs 내부 응집 비율 잘못. inbox 는 PM 도메인의 한 측면이지 별도 도메인 아님. project-manager / project-access / pm-feed-context 와 함께 두는 게 응집.

inbox lifecycle (deferred work, candidate triage) 도 pm-feed-context 와 연결됨 (인박스 항목이 PM feed 에 등장 가능). 한 폴더에 두면 미래의 결합 지점 자연스럽게 처리.

## 왜 project-access 가 36KB 모놀리식인가

ACL 은 *결정 트리 + 캐시 + cross-domain* 의 강결합:
- damage control + path enforcement + project ACL + dotfile guard + role policy 가 한 흐름
- buildToolGuard 가 5+ 가드를 합성 — 각각 분리하면 호출자가 5번 import + 직접 합성
- in-memory cache (`getUserAccessiblePaths`) 가 모든 가드와 공유

분리하면:
- import 경로 폭발
- 가드 빠뜨림 위험 (한 가드만 import 하고 끝내는 사고)
- 캐시 invalidation 로직 분산

**deep module** — 외부 표면적은 좁음 (~10 export), 내부는 풍부한 ACL 의사결정 트리.

## 왜 `pm` 이 프로젝트 관리 (project management) 약자인가

후보:
- `project/` — project-manager 와 이름 충돌
- `projects/` — 복수형, 어색
- `pm/` — Tower 안에서 이미 PM (project management) 약자로 사용 중 (decision 문서 참조 빈번)

`pm/` 가 짧고 명확. AI 가 "PM 작업" 받으면 즉시 인식.

## 왜 pm-feed-context 가 engines/ 가 아닌가

- engines/ = Claude/Pi SDK wrapper (외부 SDK 추상화)
- pm-feed-context = *PM 데이터를 system prompt 에 어떻게 합치느냐* (PM 도메인 내부 결정)

엔진은 pm-feed-context 를 *호출자* — context 합성은 PM 책임. 분리하면 PM 정책 변경 시 engines/ 도 바꿔야 함. 책임 분리 (single responsibility).

## 왜 inbox 가 distiller 와 분리됐나

- distiller/ = 결정문서 자동 import (decision-importer, work-groups, triage candidate)
- pm/inbox = 사용자가 보고 처리하는 인박스 (UI 측 노출, accept/reject)

distiller 는 *데이터 생성*, inbox 는 *사용자 인터랙션*. distiller/triage 가 inbox.acceptCandidate 동적 호출 — 단방향. inbox 는 distiller 안 봐도 됨 (자기 데이터 자체 관리).
