# Work services

Owns canonical Work Ledger persistence, operational health, and work activity projections.

## Public API
- `upsertWorkLedgerRecord(input)` — inserts or updates one canonical work run/source record.
- `listWorkLedgerRecords(args)` — lists canonical records with project and owner context.
- `getWorkLedgerHealth(windowHours)` — reports TodoWrite write freshness, fallback coverage, and completed snapshot rate.
- `getChallengeTimeline(params)` — combines canonical records with legacy TodoWrite message snapshots into Project → Challenge timeline rows.

## Notes
- `work_ledger_records` is canonical for new runs. Persisted TodoWrite messages remain a compatibility fallback and backfill source.
- Workstream grouping prefers TodoWrite v3 fields: `work.workstreamKey` for identity and `work.workstreamTitle` for display.
- Legacy TodoWrite v2 data remains readable: `work.epic` falls back to workstream identity/title, then `work.title`, then session name.
- `work.runTitle` / legacy `work.title` describe the specific run; they should not be used as the long-lived grouping key when workstream metadata exists.
- Top-level `backlog` and `questions` can be parsed from snapshots for future detail views, but are not mixed into the main timeline rows yet.
- Legacy fallback time is based on `messages.created_at`, i.e. when a TodoWrite snapshot was persisted, not guaranteed wall-clock labor duration.
- `packages/backend/scripts/backfill-todowrite-work-ledger.ts` is dry-run by default. `--apply` is an explicit mutating operation.
- Health status degrades when recent metadata has no canonical rows, canonical writes lag messages by over 30 minutes, or completed snapshot rate falls below 50% with enough samples.
