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

### 접근 URL — Tower 표준 (2026-04-26 Phase 7 부터 통일)

모든 Tower 서버는 wildcard DNS + LE wildcard cert 를 갖추도록 표준화됨. **두 URL 패턴 모두 동작**:
- subdomain 방식: `https://<slug>.<server>/` ← **권장 (사용자 친화적, 짧고 깔끔)**
- path 방식: `https://<server>/sites/<slug>/` ← 동일하게 동작 (대체 또는 호환용)

아래 Environment 섹션의 `Site URL pattern for this server` 라인이 이 서버에 권장되는 형식을 명시함. 그대로 안내하면 됨.

**검증** — 안내 전 한 번 curl 로 200 확인 권장 (혹시 마이그레이션 미완 VM 일 수도):
```bash
curl -sk -o /dev/null -w "%{http_code}\n" "https://<slug>.<server>/"
```
만약 wildcard 가 안 되는 서버 (예: 신규 자체 호스팅 서버 미설정) 면 path 방식으로 안내 + 운영자에게 `~/workspace/scripts/setup-le-wildcard.sh` 실행 알림.

### 외부 배포 (Cloudflare Pages / Azure)
기본은 항상 위의 로컬 디스크. 사용자가 명시적으로 "외부 공개", "SEO", "글로벌 CDN", "*.pages.dev 같은 짧은 외부 URL", "동적 서버 (Python/Node)" 를 요청한 경우에만 `~/workspace/scripts/deploy.sh <name> <폴더>` 사용 (스크립트가 설치되어 있을 때).

수정은 파일만 바꾸면 즉시 반영. 삭제는 폴더 삭제 (사용자 확인 후). 팀별/프로젝트별 추가 컨벤션은 워크스페이스/프로젝트 AGENTS.md 에서 확장합니다.
