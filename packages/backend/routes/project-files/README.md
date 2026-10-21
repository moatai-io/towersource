# Project Files API

인증된 사용자의 Project 파일 탐색과 core mutation HTTP 경계를 소유한다.

## Public API
- `project-files-router.ts`의 Express Router
- 기존 `/directories`, `/files/tree|read|exists|write|create|mkdir|delete|rename|copy|search` 계약
- notes index, knowledge graph, reveal 탐색 계약

## 경계
- Project ACL과 role별 write 판정은 `services/pm/project-access.ts`가 정본이다.
- 실제 파일 연산은 `services/workspace/`가 소유한다.
- upload, inline edit, ZIP, Office/PDF/CAD preview와 streaming은 아직 legacy `api.ts`에 남는다.
- URL, status, response shape를 변경하지 않는다.

## Host symbolic-link deletion

Canonical host storage deletion accepts a final symbolic link (including a
dangling link) and unlinks only that entry; its target is never deleted.
Project ACL and role checks remain unchanged. Symlink ancestors, project-root
deletion and parent traversal remain rejected. This does not change Worker
storage, read, rename or copy contracts.
Regression: `services/project-environment/adapters/canonical-host-file-adapter.delete.test.ts`.

## Browser file canary (local implementation; live unverified)

Admin Agent management offers a confirmed `파일 API 검사` action for canonical
Projects. `BrowserFileCanaryButton.tsx` reuses the logged-in browser request
identity; no token copying, session impersonation or new execution endpoint.
`browser-file-canary.ts` calls existing exclusive create, read, write and read
APIs, requires host authority, and compares exact synthetic content. Its PASS is
**browser-file-api only**, not Worker, model, Viewer-render or download success.

The confirmation discloses one uniquely named retained text file. The generic
delete API cannot compare-and-delete atomically and can delete directories, so
the canary never auto-deletes. On response loss the file may exist: report its path,
do not retry automatically. Run in an idle trusted Project; concurrent replacement
between read and write is not protected by a CAS contract. No background runs,
binding changes or service mutations occur. UI availability requires deployment.

Tests: `packages/frontend/src/components/admin/browser-file-canary.test.ts`.

### Canonical internal alias read route validation

`project-files-internal-alias.test.ts` exercises the actual Express `/files/read`
route and canonical byte adapter over HTTP with synthetic files. Internal folder
aliases return matching content; outside/protected targets return their specific
403 failure and denied Project membership stops reads. Authentication, ACL lookup
and workspace reference/presentation wiring are fixture-injected: this is route
integration coverage, not real login, full gateway or deployed browser E2E proof.
