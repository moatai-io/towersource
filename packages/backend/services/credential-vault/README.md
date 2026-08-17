# Credential Vault

Owns workspace-level credential metadata, project inheritance/override policy, and target sync status for Tower issue #67.

## Public API

- `upsertApiKeyCredential()` — create/rotate an API-key credential without logging the value.
- `setProjectCredentialPolicy()` — allow/deny/override a credential for a project.
- `upsertGitHubActionsSecretTarget()` — bind a credential to a GitHub Actions repository secret.
- `upsertCredentialProfile()` — package non-secret env plus credential references into one connection profile.
- `setProjectCredentialProfilePolicy()` — allow/deny a connection profile for a project.
- `resolveRuntimeBoxCredentialProfileEnv()` — materialize a project-granted profile into one Runtime Box command env.
- `checkGitHubActionsSecretStatus()` — inspect whether the repository secret exists.
- `syncGitHubActionsSecret()` — set a GitHub Actions secret from the encrypted Tower secret store.
- `previewHostSecretImport()` / `applyHostSecretImport()` — copy one allowlisted host `.env` key into a project credential through a short-lived preview intent, without returning the value.

## Host secret import

This is an admin-only migration bridge for legacy host services that still keep secrets in protected `.env` files.

- Configure `TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON` as an array of exact absolute file paths and permitted key names.
- Preview validates metadata and source identity without reading the secret value.
- Apply requires the exact proposal hash, expires after 10 minutes, and is single-use.
- Apply fails if the source realpath or modification time changed after preview.
- The source file is never modified and no service is restarted.
- API responses and credential audit events contain metadata only, never the secret value.

Example configuration:

```json
[{"path":"/opt/example-service/.env","keys":["SERVICE_API_KEY"]}]
```

Do not allowlist directories, wildcard paths, or every key in a file.

## Design rule

`workspace_credentials` stores metadata only. Secret values remain encrypted in `secret_store`; target tables store only non-secret identifiers such as repo and secret name.

`credential_profiles` store non-secret env bundles and secret references by credential id. Example: a LiteLLM profile may store `LLM_BACKEND`, `LITELLM_BASE_URL`, and model names as public env, while `LITELLM_API_KEY` points to a Vault credential. Runtime Box materializes the full bundle only for a project-granted command.
