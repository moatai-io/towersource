# Agent workspace access

## Current contract — read this first

Policy authority: [team collaboration and Session revocation](../../../../docs/decisions/2026-10-11-team-collaboration-and-session-revocation.md), supplementing the [simplicity/TDD PRD](../../../../docs/decisions/2026-10-11-organization-workstation-simplicity-and-tdd-prd.md).

| Area | Observed implementation | Remaining acceptance |
|---|---|---|
| Current team facts | `team-repository.ts` owns current account/Agent/team facts; `team-context.ts` and `team-inventory.ts` reuse them. | A confirmed teamless result delegates to legacy policy; it is not permission. |
| Team management | `team-management-intent.ts` stores server-issued previews and consumes them in the mutation transaction. `../../routes/agent-teams.ts` is mounted and an administrator-only frontend panel is connected. | Default-off management flag; no live migration or browser acceptance claimed. |
| Session boundaries | `../pm/project-access.ts`, `../pm/session-audience.ts`, Session creation/list/share paths enforce current team use for connected Agents when enabled. | Team use does not grant another user's audience. Previously delivered snapshots are not recalled. |
| File I/O | FileRef team/legacy provenance feeds existing storage adapters; internal read/write chain is tested. | Public file tools/routes and command scope are not yet integrated as one user flow. |
| Command execution | Mount context/planner, signed scope, FD-pinning helper and unsupported-scope rejection exist. | Actual team executor remains unavailable; trusted registry provisioning, control/native isolation and running-job revocation are not complete. |
| File ownership | Existing canonical storage policy/adapters remain. | Common work identity convergence and end-to-end create/edit/upload/download acceptance are unfinished. |

`TOWER_TEAM_MANAGEMENT_ENABLED` and `TOWER_TEAM_WORKSPACES_ENABLED` are separate rollout guards, both default off. Neither is an instruction to activate an unfinished executor. The retired organization allowlist does not grant execution; its no-I/O setter tombstone is not another management mechanism.

### Verification owners

- Team facts and management: `team-repository.postgres.test.ts`, `team-membership.postgres.test.ts`, `team-management.postgres.test.ts`.
- Session audience and revocation: `../pm/team-session-integration.test.ts`, `../pm/session-audience.postgres.test.ts`, `../session/session-list-audience.postgres.test.ts`.
- File chain and mount planning: `team-file-chain.test.ts`, `team-mount-context.test.ts`.
- Worker prerequisites: `../execution/worker/team-mount-sources.os.test.ts`, `../runtime-box/workbench-worker-grant-admission.e2e.test.ts`.

Local fixtures, production routing, browser verification and deployment are distinct. Detailed run logs belong in work records; historical counts below are not current readiness evidence.

## Historical implementation slices

The following sections preserve incremental implementation observations and test results. Past statements such as “unimplemented” or “not connected” describe that slice; the current table above and owning code take precedence. Superseded policy is explicitly identified, not an alternative authorization rule.

## Contract

`requireAgentWorkspaceAccess` loads current requester/Agent membership and a direct workspace grant in one query. Own project workspace permits ordinary read/write for writable Agent users. Viewer/guest and read-only membership retain write restrictions. Other project workspaces and shared skills require an explicit read/read-write grant; caller role does not expand the Agent scope. No recursive grants, target Agent session access, credentials or Operator access are inherited.

Migration `196_agent_workspace_grants.sql` is additive and does not provision workspaces, grant cross-project access, change existing routes or relocate storage. Owner workspace mode is derived; linked workspace mode is stored and revocable. Grant version is returned as metadata, not a bearer authorization. Current reads are uncached; already-running OS processes require separate revocation handling.

## Current implementation boundary

The service and pure decision tests exist but are NOT connected to existing file HTTP, tool or bash paths. Do not enable route-only cross-project access before mount enforcement and storage routing are integrated. Registered workspaces are logical resources, not arbitrary filesystem roots. Mutation/provisioning API must validate receiver management AND source delegation authority. Those APIs, FileRef mapping, workspace list UI and OS mount generation remain unimplemented.

Company-wide administration is a separate management operation: an admin/operator entering through this Agent execution service cannot silently invent a grant. Existing global administrative APIs are not changed here. Source folder membership is deliberately not required for a user who accesses an explicitly connected folder through the receiving Agent.

## Verification

`access.test.ts`: 11 tests passed, including own workspace, direct read/read-write, disconnected scope for all write-capable roles, viewer/guest restrictions, shared skills, inactive resources and fresh grant revocation. Backend TypeScript check passed. Database migration and PostgreSQL query integration were not executed; no production or browser verification occurred.

## FileRef resolution slice

`file-reference.ts` resolves Agent/workspace/relativePath references after current access checks. The trusted Agent context is server-supplied and must equal the reference. Storage is resolved for the connected workspace owner, not the receiving Agent's execution Worker. Only registered project roots are supported; shared-skill locators are explicitly unavailable until registered. Parent workspace connections do not implicitly include nested Projects.

This is metadata resolution, not file I/O: realpath/fd containment, current checks before write commit, Worker liveness/scope/transport, common adapters and route integration remain required. Paths are already decoded POSIX strings; percent/colon/backslash syntax is deliberately unsupported in this first slice, so literal percent/colon filenames require a later unambiguous encoding contract. Do not use returned hostPath in unguarded fs calls. No new endpoint is activated.

Validation: access, FileRef and storage binding suites 3 files / 32 tests passed; backend no-emit TypeScript passed. All DB/authority inputs in FileRef tests are mocked, not production integration.

## Common read seam

`readAgentWorkspaceFile` now connects FileRef authorization/storage resolution to bounded byte reads (8 MiB maximum). Host reads anchor traversal to open Linux directory descriptors, reject symlinks/hardlinks/special files and check file mutation around the read. Worker reads re-resolve existing authority and compare project/root/relative path/Worker before using bounded authenticated download. Authority changes never fall back to a host mirror.

This is an internal service, not a new public endpoint. Host reads are synchronous and bounded but need off-thread integration for latency-sensitive callers. Path/mount replacement and authorization revocation are not globally atomic; write commit revalidation and mount lifecycle remain separate unfinished work. Worker containment is inherited from its existing endpoint, not newly proven by mocked read-service tests. The return value includes bytes and a FileRef, not raw host paths for user-facing presentation.

Validation: agent-workspaces suite 3 files / 29 tests passed and backend TypeScript passed. The new read tests exercise real local HTML bytes and link/size rejection, with mocked authority; Worker transport is mocked here. No DB migration, route activation, browser verification, production operation or deployment occurred.

## Existing text replacement staging

`replaceAgentWorkspaceText` adds an internal, not route-enabled existing-text replacement seam. It resolves write authority twice and rejects changes to grant version/storage context. Host files use fd-anchored staging, expected-content checks, identity/metadata revalidation and atomic rename; mode bits are preserved, but ownership/extended ACL metadata preservation is not yet guaranteed. Worker writes use the existing compare-and-swap command with a 32 KiB combined payload ceiling to avoid large argv transport. Host text is bounded to 1 MiB. Creation, upload and directory creation are not implemented here.

IMPORTANT: atomic rename is not linearizable CAS against arbitrary bash writers. A writer can race between the final metadata check and rename. Cross-process write coordination, permission/ACL preservation, and grant/mount revocation coordination must be resolved before enabling this path publicly. The existing Worker CAS implementation has the same compare/rename coordination limitation; reuse does not prove stronger guarantees. Do not advertise this slice as complete concurrent-edit protection.

Validation: all agent-workspaces tests 4 files / 34 tests passed, backend TypeScript passed. Real temporary files verify replacement, mode retention, stale edits, revocation and symlink rejection. Worker writes and concurrent bash races have not been integration-tested. No route activation, DB migration or deployment.

## Internal read request boundary

`read-request.ts` accepts an unknown request body and a separately authenticated, server-resolved user/Agent context. It validates exact payload keys, FileRef context/path and bounded byte limits before common I/O. Caller-provided user, host path or storage fields are rejected. The existing project-files router uses path/user ACLs without this session-derived Agent context; it is deliberately NOT switched or mounted by this slice. Future HTTP integration must authenticate Session access before constructing the context and define safe content serving (especially HTML origin/assets), mount enforcement and off-thread host reads. This adapter does not itself authenticate a Session.

Validation: 5 agent-workspaces suites / 46 tests passed; backend TypeScript passed. Request boundary tests mock common I/O. No route activation, migration or browser verification occurred.

## Session-derived read context

`session-read.ts` connects the internal request adapter to current DB user role/disabled state and the existing `canAccessSession` policy. It takes an authenticated middleware user id, loads the stored session Project, checks visibility and detects a Project change around the check. It never accepts a caller role or uses body Agent identity as authority. Session sharing does not grant workspace access: the request/common I/O chain still applies Agent membership and direct workspace grants. This is not transactional revocation or OS mount enforcement; concurrent changes after recheck remain possible. No HTTP router is mounted.

Validation: 6 agent-workspaces suites / 52 tests passed; backend TypeScript passed. Session tests mock DB/access/common request seams, covering current role, denial, disabled users, relocation/removal and downstream workspace denial. Live DB/HTTP/browser checks remain pending.

## Internal chain integration evidence

`read-chain.integration.test.ts` retains the real session adapter, request validator, workspace access service/decision, FileRef resolver, explicit storage resolver and host file I/O. Only DB facts, session-visibility policy and Worker transport are fixtures. It verifies real HTML reads, read-only write refusal with unchanged bytes, read-write replacement followed by the same read chain, next-request grant revocation, missing direct grant before storage discovery and blocked-storage refusal despite readable host bytes. This is not PostgreSQL query correctness, HTTP/Viewer E2E, concurrent writer safety or OS mount verification.

Executed: 7 agent-workspaces suites / 58 tests passed; backend TypeScript passed. No routes, DB migrations or production settings activated.

## Mount intent planner (not activated)

`mount-plan.ts` converts supplied current authority facts and registered local storage roots into mount intents. It reuses read/write access decisions, retains requester read-only restrictions even on read-write grants, uses `/workspace` for own storage and deterministic hashed `/connected/` targets for linked storage. Missing/revoked grants, duplicate/overlapping sources, mismatched/unregistered roots and parent roots containing another registered Project are rejected. It does not recursively expand grants. Remote Worker storage and shared-skill locators are explicitly unsupported rather than mapped to controller mirrors.

This is a pure planner: it does not query the grant inventory, resolve realpath/symlinks, install mounts, restrict native Operator host access or enforce running-process revocation. The executor must verify local storage placement, source identity/containment and current authorization before activation; this output is not a capability token. These prerequisites remain blockers for route/mount activation.

Validation: 8 agent-workspaces suites / 67 tests passed; backend TypeScript passed. Planner tests use synthetic authority facts and paths; no OS mounts, migration, HTTP or production changes occurred.

## Disposable PostgreSQL verification

`AGENT_WORKSPACE_PG_TEST=1 npx vitest run packages/backend/services/agent-workspaces/access.postgres.test.ts --maxWorkers=1` starts a private disposable PostgreSQL 18 cluster below `work/`, listening only on a unique Unix socket directory (no TCP). It does not use the application DB URL. Requires local PostgreSQL 18 binaries and a non-root OS user. The fixture applies migrations 195/196 twice against a minimal prerequisite schema and calls the actual access service SQL. Own write, connected read, read-only denial, A→B→C non-inheritance and committed revocation pass. The test stops its server and removes its own temporary cluster.

Executed: 2 PostgreSQL tests passed; backend TypeScript passed. This validates actual SQL/types and additive migration repeatability against a minimal schema, NOT the entire production migration chain or Worker/Viewer integration. No registered Agents, production DB, mounts or service settings changed.

## Real mount enforcement fixture

`AGENT_WORKSPACE_MOUNT_TEST=1 npx vitest run packages/backend/services/agent-workspaces/mount-plan.os.test.ts --maxWorkers=1` consumes real planner output and starts a disposable bwrap namespace with a minimal environment. Local Linux user namespaces and `/usr/bin/bwrap` are required; enabled tests fail rather than silently skip when bwrap cannot execute. Existing linked bytes remain readable, overwrites on read-only binds fail with EROFS, own storage remains writable, and read-write binds allow overwrite/create/rename/delete. An unconnected fixture directory is absent both directly and through a symlink from the linked directory.

Executed: 2 real OS tests passed; backend TypeScript passed. This proves the fixture's bwrap mount flags, not integration of planner output into the actual Worker server. No running Worker, production folders, DB or service policy changed. Remaining activation work includes server-derived grant inventory, authoritative storage locality/source verification, actual executor wiring and revocation lifecycle.

## Direct workspace inventory

`workspace-inventory.ts` queries own active workspace plus direct, unrevoked grants of the receiving Agent only. Every returned resource goes through current read/write access checks; requester write restrictions remain read-only. Non-permission failures propagate instead of producing a partial list. Changed grant versions on successful write recheck are rejected. Inventory is capped at 256 resources with explicit failure on overflow. Output contains resource ids/mode metadata, not host locators or mount authority. This internal function still requires authenticated caller context; an empty result is not proof of Agent access. It does not provide transaction-wide revocation guarantees or recursively expand target-Agent grants.

Real PostgreSQL fixture now verifies the inventory query returns only A's own workspace and direct B connection, excluding B's C connection. Executed with PostgreSQL enabled: 10 suites / 76 tests passed; 2 opt-in OS mount tests skipped in this run (previously passed explicitly); backend TypeScript passed. No API/Worker mount activation occurred.

## Delegated access and storage execution

Agent FileRef authorization and direct Project membership are alternative entry
policies, not cumulative requirements. Internal Agent read/replacement resolves
current Agent membership and the direct grant, then invokes the same storage
adapter used by the Project gateway. It does not pass a membership-bypass flag
through a public API. Direct Project callers retain their current access checks.
The shared adapter validates expected storage placement; it is an internal I/O
primitive and never authorizes a caller by itself.

The read-chain fixture now models a requester with no target membership. Its
positive read/write tests prove delegated access; negative tests retain direct
Project denial and reject absent grants even with target membership. Grant
revocation and write revalidation tests remain. No HTTP/tool/Worker mount path
is activated by this change. Running-process revocation, final-check/publication
races and organization-shared execution remain unfinished.

Validation: targeted cross-module run, 17 suites: 15 passed / 2 skipped;
189 tests passed / 2 expected failures / 5 skipped. Backend no-emit TypeScript
passed. This is local service/filesystem evidence, not production, authenticated
HTTP, live PostgreSQL or actual executor mount activation.

## Team file policy and Session audience (integration pending)

The approved direction groups existing Agent folders by a single Agent team;
a user may join multiple teams, but the running Agent sees only its team's
workspaces. `team-workspace-policy.ts` implements a pure current-facts inventory.
`team-session-boundary.test.ts` verifies that its file result is not converted
into Project membership or Session read/contribution authority. Team membership
must never seed `project_members` or pairwise workspace grants. Existing Session
visibility/private policies are not automatically expanded by team invitations.

This policy is not yet a DB/HTTP/executor boundary. The legacy Agent entrance
requires Project membership and therefore cannot simply be composed as an
additional check for team-only users. The server resolver needs explicit team
and legacy branches; current account/Agent checks remain mandatory. A team user's
own Session access also needs separate integration without opening another
user's Session. Session creation defaults and departure/revocation lifetime must
be specified before activation. Team Credential sharing and system privileges
are not implemented or granted by this policy.

## Team collaboration slice (not activated)

Team membership is a file/Agent-use relationship, not Project membership or
Session audience. `team-workspace-policy.ts` owns pure current-fact admission
and team-local workspace selection. `team-context.ts` resolves current DB facts;
only an existing teamless Agent returns null for a caller's legacy branch.
Denied team access and database errors must not become legacy fallback.
`team-inventory.ts` is an internal bounded inventory; it does not supply mount
capabilities or authorize writes. These services are not connected to HTTP,
Agent creation, actual command execution or public file routes yet.

Never seed `project_members` or pairwise workspace grants from team membership.
People may belong to several teams, but a running Agent sees only its own team.
Existing Session read/send/content policies remain separate. Team-based owners'
new Session creation/listing/access must be integrated together; widening
`isProjectMember()` would expose other users' existing Project Sessions.

The earlier `execution.organization-admission.<userId>` implementation is an
unactivated intermediate slice, not an additional requirement for team members.
It must not become a second allowlist beside explicit team invitations. Its
removal/replacement and executor integration remain pending.

### Current Session contract and superseded experiment

The accepted [team and Session decision](../../../../docs/decisions/2026-10-11-team-collaboration-and-session-revocation.md)
is authoritative. For team-connected Agents, current team use is a prerequisite
for read and resume, including own history and retained Project membership or
internal shares. Team use alone never creates another person's Session audience.
Confirmed teamless Agents retain legacy policy; lookup failures never fall back.

An earlier experimental explanation preserved existing read audience after team
revocation. It contradicted the accepted requirement and is superseded. Its test
counts do not validate the current policy. Current regression owners are
`../pm/team-session-integration.test.ts`, `../pm/session-audience.postgres.test.ts`
and `../session/session-list-audience.postgres.test.ts`. Execution-process
revocation and recall of previously delivered external snapshots are distinct
limitations, not guarantees from these tests.

## Team integration checkpoint (default off)

Current team facts are loaded by `team-repository.ts`; context and inventory
reuse that snapshot rather than reinterpreting membership. Teamless returns to
legacy policy, not automatic permission. Team-connected Session read and resume
require current team use even when Project membership remains. A team's file
access does not itself confer another user's Session audience. Own new team
Sessions default to private; archived/list/search/share entry points use the
same revocation contract. Existing externally delivered snapshots are not
retroactively recalled.

Management uses `team-management.ts` and server-held
`team-management-intent.ts`: actor/hash/expiry and current version are checked,
then receipt consumption and mutation commit in one transaction. Migrations
236/237 define affiliation and approval receipts separately. No automatic
Project membership, pairwise file grant, credential or Session sharing rows are
created. `/api/agent-teams` is registered but returns disabled unless the server
explicitly enables `TOWER_TEAM_MANAGEMENT_ENABLED=1`; workspace consumers remain
behind `TOWER_TEAM_WORKSPACES_ENABLED=1`. Neither flag is deployment readiness.

The team mount context resolves server identities and canonical storage, not
caller-supplied paths. Signed execution grants bind team scope but consumers
reject that scope by default. Path strings/snapshot rechecks do not pin actual
bind sources, isolate native same-UID processes, or terminate revoked jobs.
Actual executor activation, process revocation and management UI integration
remain unfinished; do not enable the flags from unit-test success alone.

Parent verification checkpoint: 37 selected suites / 710 tests passed with
isolated PostgreSQL and bwrap flags enabled. Management router and signed-scope
selected tests: 81 passed (overlapping coverage, not additive). Backend typecheck
passed. These are local checks, not live migration, browser or production evidence.


### AI Team home: visual grouping is not authority

The accepted UI direction is one face-card directory, with a mutually exclusive visual-team view rather than a second directory stacked above it. Actual administrator participation must use the existing explicit join endpoint, with confirmation; browsing or visually grouping an agent must not acquire membership.

`GET/PATCH /api/agent-visual-teams` stores organization-shared presentation metadata in the existing `app_settings` table (`agent_visual_teams_v1`). No new database migration is required. Fresh active-account checks, administrator-only mutations and `expectedVersion` conflict checks protect updates. Non-admin snapshots contain only their accessible Project assignments and related teams. This metadata must never be used as an ACL, Credential grant or messaging grant.

The visual board supports creating a team, moving an agent between visual teams and returning it to ungrouped. The UI uses server-confirmed responses, blocks duplicate saves, reloads on concurrent-edit conflict and requires reload after an uncertain save. Loading/failure is never rendered as known ungrouped membership.

Existing `/api/agent-teams` is a separate **authority-team** contract: assignment may expose registered workspace files to eligible team members, reassigning an existing team requires migration, and the feature is default-off. The visual board must never call that API. Future Credential and agent-conversation sharing needs separate grants, revocation semantics and verified enforcement; visual movement is not consent for those actions.

Code: `packages/frontend/src/components/agents/VisualAgentTeams.tsx`, `packages/backend/routes/agent-visual-teams.ts`, `services/agent-workspaces/visual-teams.ts`.
Tests: colocated `VisualAgentTeams.test.tsx`, `visual-teams.test.ts`, route tests and AI Team home tests. A local Chromium fixture checks visual creation/movement and desktop/mobile layout against a mock API, not live authentication or production persistence. No deployment or production migration has been performed by this change.


Local verification for this iteration: `npm run typecheck` passed; 12 targeted frontend/backend test files passed (100 tests); `VISUAL_TEAMS_PG_TEST=1` disposable PostgreSQL tests passed (5 tests), covering JSONB persistence, concurrent CAS, current account checks, membership filtering, and no authority side effects. The PostgreSQL fixture uses an isolated temporary cluster, not the application database. Chromium exercised the actual home component and visual board at 1280px and 390px with mocked API responses; production authentication, actual join and live persistence still require deployment verification.
