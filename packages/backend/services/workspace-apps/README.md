# Workspace Apps service

Owns the local-metadata implementation for the private `workspaceAppsEnabled` beta. The product framing has moved toward **DIY ERP Connector**: Tower should connect to Frappe-like ERP/business app backends instead of becoming an ERP engine itself. This module remains the local metadata fallback/Pilot-A path while `workspaceAppsMode=frappe-connector-pilot` dogfoods the connector direction.

Public API:
- `loadWorkspaceAppDefinitions(projectRoot)` scans `apps/**/app.yaml|app.yml|app.json` inside one registered Project workspace.
- `normalizeFrappeSiteUrl(...)`, `describeFrappeDocType(...)`, `listFrappeRecords(...)`, and `readFrappeRecord(...)` provide the read-only Frappe connector adapter skeleton for the DIY ERP Connector Golden Path.
- `listMockFrappeObjects(...)`, `describeMockFrappeObject(...)`, and mock record/action helpers back the no-server `frappe-connector-pilot` dogfood mode.
- `findWorkspaceAppReadQuery(definition, queryId)` validates that a requested query is registered and read-only.
- `runWorkspaceAppSqliteReadOnlyQuery(...)` reads project-local SQLite files in read-only mode for the SQLite-first beta path.
- `runWorkspaceAppReadOnlyQuery(...)` keeps the Neon read-only adapter available for later external DB promotion.
- `executeWorkspaceAppAction(...)` executes only registered SQLite `create|update|change-status` actions against configured `record/fields/actions` metadata and records receipts under `.workspace-apps/actions/<appId>/`.
- `saveWorkspaceAppDraft(...)` stores validated draft intent JSON under `.workspace-apps/drafts/<appId>/` without touching `app.yaml`.
- `previewWorkspaceAppDraftPublish(...)` builds before/after text and hashes for a draft without writing source files.
- `applyWorkspaceAppDraftPublish(...)` atomically updates `apps/<app>/app.yaml|json` only after explicit confirmation plus matching `expectedBeforeHash` and `previewHash`.
- `routes/workspace-apps-api.ts` exposes validated definitions, read-only query rows, guarded action endpoints, draft-save/list/read endpoints, publish-preview intent endpoints, and confirmed publish endpoints to the frontend.

Rules:
- Customer/self-hosted VMs default off. This is an operator/full VM private beta unless explicitly enabled.
- `local-metadata` mode is not the final product center; it is a safe local renderer/action sandbox while the Frappe connector Golden Path is validated.
- `frappe-connector-pilot` can run without a real Frappe server through backend mock connector endpoints. The frontend pilot now has a source boundary: `Mock Frappe` for dogfooding and `Real read-only` for a manual `connectionId + DocType` read-only smoke.
- Real read-only input is applied only when the user presses 조회; typing a connection id or DocType should not immediately materialize credentials or call Frappe.
- Backend real-read route skeletons exist under `/connectors/frappe/connections/:connectionId/...`, and the pilot should use schema/detail `deskUrl` values for Frappe Desk links when available.
- `/connectors/frappe/connections/:connectionId/readiness` checks project credential materialization and JSON shape without calling external Frappe APIs. It returns only secret-free metadata such as `siteHost`, `hasApiKey`, and `hasApiSecret`.
- Real Frappe routes are read-only GET endpoints only. There is intentionally no POST/PUT/PATCH/DELETE route under `/connectors/frappe/connections/...`.
- Real Frappe credentials are expected as a JSON credential value with `siteUrl`, optional `deskUrlBase`, `apiKey`, and `apiSecret` (or `FRAPPE_SITE_URL`, `FRAPPE_DESK_URL_BASE`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET`). Do not paste these in chat or the pilot screen; use Credential Vault when enabling a real connection.
- `siteUrl` is the backend API URL and still requires HTTPS outside localhost/127.0.0.1 because it carries API tokens. `deskUrlBase` is browser-facing link-only metadata, so dev HTTP URLs such as `http://desk-dev.tower.example.com:8080` are allowed for disposable smoke environments.
- The pilot may show a setup guide with placeholder JSON only (`<FRAPPE_API_KEY>`, `<FRAPPE_API_SECRET>`). Never render or persist real credential values in app metadata, logs, source files, or chat.
- Real Frappe credential materialization requires an authenticated user id and goes through `resolveProjectCredentialSecretValue` with provider `frappe`.
- Real connector writes stay disabled until permission mapping, audit receipts, and DocType transition policy are designed.
- SQLite is the first local smoke provider. DB files must be project-relative, realpath inside the project root, and `.db|.sqlite|.sqlite3`.
- Neon remains a later external provider. Definition files may reference a `connectionId`, but secret values stay in Credential Vault.
- SQL snippets must be registered in app definitions and pass the fail-closed read-only policy before read execution.
- SQLite writes are not arbitrary SQL: only registered `actions` may write, only configured `fields` may be changed, status/select values must match configured options, and `delete` is intentionally absent.
- Draft save and publish preview are not publish: they create/review intent records only and never mutate `apps/<app>/app.yaml`.
- Confirmed publish is the only path that mutates `apps/<app>/app.yaml`; it must reject unconfirmed, stale, or mismatched-hash requests.
- The service does not expose raw SQL input UI, migrations, destructive writes, arbitrary table writes, publish without approval, or arbitrary code execution.
- Invalid definitions are skipped with warnings so one broken draft does not blank the whole Apps tab.
