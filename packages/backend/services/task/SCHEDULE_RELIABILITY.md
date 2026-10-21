# Schedule reliability contract

The registry uses `schedule-clock.ts` for timezone-aware recurrence. The default timezone is Asia/Seoul, independent of the host TZ. Calendar schedules fire at most once per local day; nonexistent DST wall times are skipped. Intervals measure elapsed minutes. Weekly searches cover a skipped DST occurrence.

YAML calendar schedules use a structured inline mapping, not a translated display label:

```yaml
trigger:
  type: time
  schedule: {type: daily, hour: 9, minute: 0}
  timezone: Asia/Seoul
```

Unsupported natural-language edits and malformed intervals fail rather than silently retaining or substituting execution settings.

AI spawn runners await `spawnTask`, read its persisted terminal outcome, and return a Task ID plus an explicit `completed-session:` runner reference when available. Historical `success` rows without a verified reference remain unverified. Tasks remain silent to avoid duplicate delivery; the scheduler/manual controller emits the terminal Automation Notification. This does not implement arbitrary `resultTarget`, conditional reporting, or persistent session continuity.

Manual executions record thrown runner failures. An executed one-shot is consumed, including a failed attempt; a recurring schedule keeps its next occurrence. Lock contention is not a consumed run.

A single-flight guard prevents overlapping automation timer ticks in one process. This is not a distributed lease. The scheduler still processes due rows sequentially; long jobs can delay later jobs. DB-backed claims, bounded dispatch concurrency, crash recovery, configurable missed-run policies, and durable delivery retries remain separate work. Do not run multiple active scheduler processes against the same registry expecting exactly-once execution.

The schedule views refresh every 30 seconds while visible. This is polling, not a real-time execution stream.

## Regression coverage

- Zoned clock: Seoul, fractional offsets, weekends, weekly recurrence, DST gaps/folds, active hours and invalid inputs.
- YAML round trips and executable time changes; reject unsupported interval and natural-language input.
- AI terminal success/failure and local concurrent-run exclusion.
- Manual exception ledger, one-shot consumption and contention.
- Verified result references versus historical dispatch-only records.
