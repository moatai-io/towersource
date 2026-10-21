# Local usage calendar contract

Status: implemented locally; fixture-tested; not live-verified.

## Scope

`usage-period.ts` owns the calendar boundary and plotted-series invariants used by
`GET /api/metrics/my-ai-usage` and `GET /api/metrics/usage-heatmap` in
[`routes/api.ts`](../../routes/api.ts). It does not define Router/Team billing totals.

- A request captures one UTC calendar window: `[today − (days − 1) at 00:00 UTC, tomorrow at 00:00 UTC)`.
- All SQL queries and the date axis use that same captured window. SQL parameters are explicit ISO instants cast to `timestamptz`.
- `messages.created_at` is `TIMESTAMPTZ` in migration `008_sessions.sql`. Grouping uses `(m.created_at AT TIME ZONE 'UTC')::date`, independent of the PostgreSQL session timezone. This is a source-schema check, not a live database inspection.
- Personal usage is scoped to `sessions.user_id = authenticated user`. Sessions count distinct sessions having messages in the period. Turns count user messages; tokens sum message input/output fields; costs sum assistant `metadata.usage.cost_usd`. Lifetime session counters and costs never fill missing period data.
- Personal `costBasis` is always `message-provider-metadata`. `costAvailable` means at least one assistant cost sample exists, including an explicitly reported zero; it does not certify complete accounting coverage. Without samples the numeric sum is zero and `costAvailable=false`.
- Project heatmap preserves the existing owner/project-member ACL, archived-project exclusion, and exact legacy user-text prefix filter. This serialized-content filter is intentionally not broadened by the calendar fix. It is not a count of all user input formats or model API requests.
- Each project's `total` is the sum of its plotted `values`. Its `activeDays` counts nonzero user-activity dates, not assistant-only activity dates.
- `dailyTotals` covers all accessible projects, not only Top-N. `grandTotal = sum(dailyTotals)`. Empty activity still returns the full date axis and zero daily totals.
- Heatmap session counts retain the existing distinct-session-with-any-message-in-window semantics. Top-N limits only the displayed project rows.

## Verification

- `usage-period.test.ts`: UTC-offset, leap-day, single-day/DST calendar boundaries and on-axis series invariants.
- `usage-period.integration.test.ts`: transpiles only the two actual route bodies and executes their SQL against a disposable local PostgreSQL with synthetic fixtures. Does not load application credentials, the production connection string, or live data.
- Numeric regressions cover old sessions with large lifetime counters, inclusive start/exclusive end, foreign session ownership, project ACL/archive exclusions, Top-N independence, assistant-only days, explicit zero versus unavailable cost, and database timezone changes between Asia/Seoul and America/Los_Angeles.
- Integration cases run when local `initdb`/`pg_ctl` binaries exist and the process is non-root; otherwise they are explicitly skipped. `USAGE_TEST_PG_BIN` may point to a local PostgreSQL binary directory. Pure/source cases always run.

```sh
npx vitest run packages/backend/services/ai-usage/usage-period.test.ts packages/backend/services/ai-usage/usage-period.integration.test.ts --maxWorkers=1
```

The fixture suite validates handler computation and SQL, not Express middleware registration, live deployment, or Router billing reconciliation.
