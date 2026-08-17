# Host Secret Import

Owns: admin-only, purpose-built migration of one allowlisted key from a host `.env` file into Credential Vault without returning the secret to the browser or AI context.

Public API:
- `previewHostSecretImport()` validates an allowlisted source and issues a short-lived, server-held intent.
- `applyHostSecretImport()` consumes the exact intent and writes the value to Credential Vault plus the project policy.

Configuration: `TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON` must be a JSON array of `{ "path": "/absolute/file", "keys": ["ENV_KEY"] }`. No path is allowed by default.

Security contract: exact realpath and key allowlist, admin API only, 10-minute single-use intent, proposal hash binding, no secret value or value-derived hash in responses/logs, source file unchanged.
