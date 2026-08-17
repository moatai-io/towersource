# Credential Vault decisions

- MVP reuses `secret_store` for encrypted values instead of introducing a second encryption path.
- `workspace_credentials.secret_name` is an identifier that resolves into `secret_store`; it is not a secret value.
- GitHub Actions sync shells out to `gh secret set` with the secret passed on stdin, never on argv or logs.
- Runtime Box trusted credential pool remains compatibility code for CLI/OAuth-style providers (`gh`, `az`, `gws`). API-key env materialization is now resolved from this vault immediately before `docker exec`.
- Runtime Box duplicate env precedence: caller-provided env wins over vault. Rationale: an explicit per-command env is narrower than project policy and avoids surprising replacement. The vault value is not decrypted when a caller env already exists for that key.
- Runtime Box MVP injects every project-policy-allowed API-key credential into the single command environment. The value is command-scoped (`docker exec -e`) and not persisted in `/workspace`; finer command classification can come later if leakage risk becomes too high for broad project policies.
- Credential Profiles are the canonical way to package a full connection, not just one secret. A profile may contain non-secret env (`LLM_BACKEND`, `LITELLM_BASE_URL`, model names) plus `secret_refs` (`LITELLM_API_KEY` → credential id). Profile materialization requires both project profile allow and project credential allow for every referenced secret credential.
- Profile public env must not contain secret-looking names (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE`) unless represented as a secret ref. This prevents accidental storage of secrets in JSON metadata.
