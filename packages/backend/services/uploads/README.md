# Uploads service

Owns project-scoped upload flows that should not be stored in git history.

Public API:

- `resumable-upload-manager.ts` — orchestrates session/create/status/chunk/complete/cancel.
- `resumable-upload-store.ts` — PostgreSQL metadata access.
- `resumable-upload-storage.ts` — local disk staging and finalize primitives.
- `resumable-upload-quota.ts` — project upload quota calculation.
- `resumable-upload-paths.ts` — safe path and staging path helpers.

Important rules:

- Upload bytes are streamed to disk, not held in backend RAM.
- Uploads never call git `autoCommit()`.
- Project uploads accept script/executable-looking filenames as inert files; execution and public publishing remain separate guarded flows.
- Staging lives under `workspace/projects/<project>/uploads/.staging/<sessionId>/`.
- Final files live under a writable project `uploads/` target chosen by the user.
- Project quota defaults to 4GiB.

Decision: `workspace/decisions/2026-06-08-large-folder-resumable-upload.md`.
Issue: https://github.com/juliuschun/tower/issues/79
