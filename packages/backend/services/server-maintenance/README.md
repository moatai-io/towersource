# Server maintenance: default monitoring, opt-in deletion

Single backend process only; do not enable multiple replicas against the same state.
Disk monitoring is enabled by default, including customer servers after deployment.
Backup deletion is disabled by default and requires independent server-specific approval.
No frontend changes or DB migrations. Runs a disk check every 15 minutes and backup retention every 24 hours
(first execution is immediate after enabling).

Explicit configuration:
- `TOWER_DISK_MONITOR_ENABLED=0`: disable default-on disk monitoring
- `TOWER_BACKUP_RETENTION_ENABLED=1`: explicitly authorize configured backup deletion
- `TOWER_SERVER_MAINTENANCE_ENABLED=0`: legacy emergency switch disabling everything; `1` does not authorize deletion
- `TOWER_SERVER_MAINTENANCE_STATE_DIR`: private persistent directory; default `<config.dataDir>/server-maintenance`
- `TOWER_DISK_MONITOR_PATH`: monitored filesystem path, default `config.dataDir`
- `TOWER_BACKUP_RETENTION_SCRIPT`: absolute path to deployed `scripts/maintenance/retain-db-backups.py`
- `TOWER_BACKUP_RETENTION_ROOTS`: JSON array of explicitly approved absolute backup directories

Requires Python 3 and compatible `pg_restore`. Retention deletes only `*.dump` files
older than seven days, preserving the newest file in every root regardless of age and
all recent files. All retained catalogs are checked before deletion when candidates exist.
Catalog readability is NOT a restore test. No recursive directory removal. Script defaults
to dry-run; backend deliberately passes `--apply` only when explicitly enabled.
Missing/invalid backup configuration does not disable disk monitoring. Explicitly requested
retention with invalid configuration alerts without deletion. Configured roots with retention
disabled receive one setup notice per persisted state transition, not every check. No roots
are inferred. This phase does not add an administrator settings UI.

Root locks prevent concurrent pruning; deployment producers must publish completed dumps
atomically, not write directly to their final `.dump` names. State must have private ownership.

Disk alerts use available (not merely free) bytes: below 50 GiB warning, below 20 GiB urgent.
Only admin users receive `system.server-maintenance` via notification-hub. User preferences
and web-push opt-in remain authoritative. State transitions/recovery notify once; unchanged
abnormal levels remind after 24h. Retention failures notify once per daily attempt.
Normal cleanup writes only a count/bytes log. Persistent state survives restarts.

Limitation: Tower cannot reliably deliver alerts if its own disk/DB/backend is unavailable.
An independent external monitor remains a recommended separate addition. An alert error
leaves state unchanged so a later check retries. A failure after deletion but before state
write can repeat the check; already deleted files are not selected again.

Validation: `python3 scripts/maintenance/test_retention.py`,
`npx vitest run packages/backend/services/server-maintenance/policy.test.ts`, `npm run typecheck`.
Deployment requires explicit operator approval. Monitoring starts by default after deployment.
Deletion requires the separate retention switch, explicit script and roots; upgrade/fleet
must preserve approved server configuration and must never synthesize retention approval.
