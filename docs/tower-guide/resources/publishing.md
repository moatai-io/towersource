# Tower Publishing Guide Resource

This resource is loaded on demand by Pi via `guide_read` when exact Tower publishing steps, URL rules, slug rules, or deployment caveats are needed. Keep the system prompt short; keep safety-critical publishing invariants in core.

## Publishing — 사이트/앱 배포 (Tower 공통 invariant)

Tower 의 nginx 가 `workspace/published/sites/<slug>/` 를 자동으로 서빙합니다. 사용자가 웹 페이지·대시보드·계산기·도구·앱 등을 요청하면 이 규칙을 따릅니다.

### 절대 금지
- `python -m http.server`, `flask run`, `node server.js` 등 **localhost 서버를 띄우지 말 것.** 사용자 PC 의 localhost:XXXX 는 접근 불가능합니다.
- 사용자에게 "localhost 로 접근하세요" 라고 안내하지 말 것.

### 슬러그 규칙
- 소문자 영문 + 숫자 + 하이픈만 (`a-z`, `0-9`, `-`), 영문/숫자로 시작
- **Default: unlisted** — 슬러그 끝에 `openssl rand -hex 3` 6자 hex suffix 를 붙여 URL 추측 차단
- 사용자가 명시적으로 "공개로", "SEO 필요", "짧은 URL" 을 요청한 경우에만 suffix 생략 (public)

### 게시 흐름 — publish_site tool / Hub 우선
- 프로젝트 컨텍스트 안에서 작업 중이면 먼저 `workspace/projects/<project>/published/<name>/` 또는 `dist/` 같은 프로젝트 내부 폴더에 산출물을 만듭니다.
- 그 다음 하네스의 `publish_site` tool 로 `sourceDir` 를 게시합니다. backend 가 현재 세션의 사용자·프로젝트 권한을 검증한 뒤 `workspace/published/sites/<slug>/` 로 복사하고 manifest/PublishPanel 에 등록합니다.
- AI가 `/api/deploy` 를 curl 로 직접 호출하거나 `TOWER_API_TOKEN` 을 요구하지 마세요. Runtime Box/member 세션에는 게시 토큰이 없는 것이 정상입니다.
- AI가 `workspace/published/sites` symlink 를 직접 만들려고 시도하지 마세요. Runtime Box/member 세션에서는 공용 published 경로 쓰기가 막히는 것이 정상입니다.
- 프로젝트 권한 때문에 symlink/공용 published 쓰기가 실패했을 때 임시 정적 뷰어나 localhost/server fallback 으로 우회하지 말고, `publish_site`를 사용하거나 구체적 tool 실패를 보고하세요.
- `publish_site`가 성공과 검증된 URL을 반환한 경우에만 외부 URL을 안내하세요. 실패 시 URL을 추측해서 만들지 마세요.
- publish용 HTML을 새로 만들 때는 가능하면 대표 썸네일 힌트를 넣으세요: 대표 hero 섹션에 `data-tower-thumbnail`을 붙이거나 `<meta property="og:image" ...>` / `<meta name="twitter:image" ...>`를 지정합니다. Tower는 AI 이미지 생성 없이 실제 페이지/대표 이미지 기반 썸네일을 만듭니다.

### 접근 URL — 서브도메인 단일 정본

정본 게시 주소는 `https://<slug>.<server>/` 하나입니다. AI 안내·새 게시 응답·복사 버튼에 `/sites/<slug>/`를 사용하지 않습니다. 내부 저장 폴더 `workspace/published/sites/<slug>/`는 URL 정책과 별개로 유지합니다.

서브도메인의 DNS·TLS·실제 콘텐츠와 참조 자산을 검증합니다. 인증서 검증을 끄거나 HTTP 200만으로 성공을 선언하지 않습니다. Tower SPA가 대신 반환되면 실패입니다. 서브도메인이 실패하면 구체적인 장애를 보고하고 `/sites/` 주소를 대안으로 제시하지 않습니다.

기존 `/sites/<slug>/` 링크는 운영자가 별도 승인으로 정본 URL로 리다이렉트하는 호환 입구입니다. 하위 경로와 쿼리를 보존하고 미등록 slug는 404로 처리합니다. 이 정책은 각 VM에 이미 적용됐다는 뜻이 아닙니다. 호환 경로 결과는 정본 Publishing 상태와 분리합니다.

### 외부 배포 (Cloudflare Pages / Azure 등)
기본 경로는 Tower Publishing Hub의 `publish_site`입니다. 사용자가 외부 CDN, 별도 도메인 또는 동적 서버 배포를 명시적으로 요청하면 해당 provider의 승인된 연결·배포 workflow를 별도로 사용합니다. 이 문서는 host별 `~/workspace/scripts/deploy.sh`의 존재나 권한을 가정하지 않으며, 외부 배포는 `publish_site` 성공으로 간주하지 않습니다.

게시물 수정·보관·삭제도 Publishing Hub 또는 승인된 provider workflow를 사용합니다. 공용 published 폴더를 직접 수정하거나 삭제하지 않습니다. 파괴적 변경은 사용자 확인이 필요하며, 팀별/Project별 추가 규칙은 AGENTS.md에서 확장합니다.
