# Decisions

- Workspace Apps starts as a private full-VM beta behind `workspaceAppsEnabled`; self-hosted servers default off.
- Product framing is now DIY ERP Connector, not Tower-as-ERP. The local metadata renderer is a retained mode/fallback, while Frappe connector pilot is the first Golden Path candidate.
- App definitions are file-backed under `apps/**/app.yaml` so AI and admins can review them like code before later publish flows.
- SQLite is the first live-data provider because it lets the beta prove the metadata renderer and query path without Credential Vault, external network, or Neon setup friction.
- Neon remains the external/production-oriented provider path. Neon secrets must stay in Credential Vault and definitions may only store `connectionId`.
- Read paths stay fail-closed: registered query only, single statement, SELECT/WITH only, forbidden write keywords, timeout, and row limit.
- SQLite database paths must be project-relative and realpath inside the registered project root; symlink/path escape is rejected.
- SQLite write paths are metadata actions, not raw SQL. The beta only allows registered `create`, `update`, and `change-status` actions against configured `record.table` and `fields`; no delete/destructive action is exposed.
- Invalid definitions are skipped with warnings so one broken draft does not blank the whole Apps tab.
- Draft persistence writes only intent records under `.workspace-apps/drafts/<appId>/`; publish/app.yaml mutation remains a separate future step requiring stronger approval/audit.
- Publish preview may compute before/after source text and hashes, but must not write app.yaml. Confirmed publish is a separate endpoint requiring expected hash and explicit approval.
- Confirmed publish writes only the app definition source file via same-directory temp + rename, then records a publish receipt under `.workspace-apps/publishes/<appId>/`.
