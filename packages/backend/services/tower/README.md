# services/tower — Tower channel + persona infrastructure

> The single AI ↔ user front door. All autonomous run reports, alerts, and
> proactive observations flow through here.

## Responsibility

- Maintain exactly one workspace-level `chat_rooms` row with `kind='tower_system'`
- Provide `postToTowerChannel()` — the standard helper for every future
  scheduler / runner / proactive monitor
- Carry the Tower persona voice (see `templates/workspace/tower-persona.md`)

## Public API

```typescript
import {
  ensureTowerChannel,    // call once at startup with admin user_id
  getTowerChannel,       // cheap lookup, returns null if not yet ensured
  postToTowerChannel,    // the standard posting helper
  TOWER_DEFAULT_NAME,
  type TowerSeverity,    // 'L1' | 'L2' | 'L3' | 'L4'
} from '../tower/tower-channel.js';

// Severity routing — Phase 2
import {
  normalizeSeverity,           // coerce unknown → 'L2' fallback
  severityFromReportPolicy,    // legacy task report_policy → severity
  routeSeverity,               // severity → { channelPost, mention, boardIssue }
} from '../tower/severity-router.js';
```

Posting example:

```typescript
await postToTowerChannel('이거 끝났어요 → Run #47', {
  severity: 'L2',
  runSessionId: 'sess_abc',
  source: { kind: 'schedule', id: 'sched_xyz' },
});
```

## Severity contract (Phase 2)

| Tier | What this module does today |
|------|-----------------------------|
| L1   | No-op. Returns `{ message: null }`. Never writes. |
| L2   | Posts to channel with `metadata.persona='tower'`. |
| L3   | Same as L2 + (Phase 2) caller marks `boardIssueId` for Phase 3 to render. |
| L4   | Same as L2 + records `mentionUserIds` in metadata. **Phase 3** will fan out OS push. |

Phase 2 added:
- `unified-scheduler.ts` posts a one-line summary on every successful or
  failed schedule fire. Failed runs get bumped one tier (L2 → L3) for
  visibility. L1 schedules stay silent.
- `task-runner.ts` mirrors `dispatchReport` to the Tower channel as a
  *funnel* — original kakao push and room post still fire for backward
  compat. Phase 3 will retire the duplicate paths.

Callers should set severity correctly *now* — Phase 3 will upgrade routing
without changing call sites.

## Before calling postToTowerChannel

You must have called `ensureTowerChannel(adminUserId)` at startup.
`backend/index.ts` does this after migrations + `seedDefaultProjects`.
If you call `postToTowerChannel` before the channel exists, it throws —
that's the contract (fail loud).

## Related decisions

- `workspace/decisions/2026-05-04-tower-channel-and-persona.md` — the why
- `tower/docs/plans/2026-05-04-tower-channel-implementation.md` — phased plan
- `workspace/decisions/2026-04-22-task-report-policy.md` — earlier severity attempt
- `workspace/decisions/2026-04-27-d16-threads-mission-control.md` — sister UI

## Adjacent modules to know about

- `services/room/room-manager.ts` — generic room CRUD; we sit on top of it
- `services/notification-hub.ts` — to be funneled through us in Phase 3
- `services/ai/proactive-agent.ts` — future Tower-persona wrapper (Phase 5)
- `services/task/unified-scheduler.ts` — will call us on schedule_runs (Phase 2)
