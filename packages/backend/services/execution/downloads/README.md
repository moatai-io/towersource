# Managed public downloads

Owns: public HTTPS transfer, checkpoint, Range safety, bounded retries and checksum verification.
Entry point: `project_download` in `engines/pi-runtime-box-tools.ts`; lifecycle: existing Project Job.
Decision: `docs/decisions/2026-10-06-managed-download-jobs.md`.

`download-contract.ts` validates URL, relative destination and policy; `download-script.ts` runs Python3 inside the selected executor. It never injects operational credentials. Signed/query URLs are intentionally unsupported because commands persist in the Job ledger.

Defaults: connect/headers 30s, body idle 120s, 3 attempts, overall 86400s. `.part`, `.download.json`, `.download.lock` live alongside the destination. Same source fingerprint, expected size and checksum metadata are required to resume. With a validator, the existing If-Range path is used. Without a validator, an explicit manifest size and SHA-256 or MD5 are mandatory: re-fetch up to 64KiB before the offset, compare those bytes before appending, then verify the entire checksum before finalization. MD5 detects accidental corruption only, not adversarial authenticity. Existing target or unknown partial is blocked, not overwritten. When present, ETag/Last-Modified must match; Content-Range must always match the actual requested start. The final file is created without overwriting another writer.

`TOWER_DOWNLOAD_PROGRESS` lines update `project_process.download`: phase, bytesReceived, bytesWritten, lastByteAt, lastDiskGrowthAt, observedAt, attempt, HTTP/Range result, errorCode and nextAction. `running` and heartbeat indicate only liveness. `unverified`, `stale`, `blocked`, `interrupted` are not normal transfer. SHA-256 is preferred; MD5 is accepted for official manifests such as Zenodo. No checksum supplied means `checksumVerified=false`, not an integrity proof.

Failure recovery: preserve partial/checkpoint; inspect error code and fix that condition, then repeat the exact download. Range mismatch/remote change/unknown metadata require human review before restarting from zero. Do not blindly append or delete files. After forced termination verify no original process owns the lock before removing it; automatic lock takeover is not implemented. Job cancellation uses the existing executor abort path.

Migration `233_download_job_deadline.sql` widens the DB constraint. API/Worker keep ordinary limits and accept the extended deadline only for an exact managed command. No live migration is run by local tests.

Tests: `download-contract.test.ts` runs the actual script with a deterministic urllib fixture and real temporary files; Job registry/process projection tests verify timeout and freshness boundaries. These tests are not a live HTTPS or remote deployment verification.

Strict tool-schema compatibility: omit the unused checksum or send `null` (e.g. official `md5` plus `sha256: null`). The backend removes null properties before command creation. Never supply an invented hash. Two non-null hashes still fail with `SUPPLY_ONE_CHECKSUM`. Decision: `docs/decisions/2026-10-07-nullable-download-checksum-inputs.md`.
