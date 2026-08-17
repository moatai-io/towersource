# services/tower — internal design decisions

Rationale for non-obvious shape choices in this module. Read before refactoring.

## Why a separate `kind` column on chat_rooms (not just `room_type`)?

`room_type` describes *purpose* — `team` / `project` / `dashboard`. Whether a
room is user-managed or system-managed is **orthogonal** (a project room could
in principle also be system-auto-created). Keeping them separate lets us:

- Add more system-managed rooms (e.g. `kind='broadcast'`, `kind='alerts'`)
  without overloading `room_type`
- Filter "all user rooms" easily (`WHERE kind='user'`)
- Enforce singleton via partial unique index

## Why a partial unique index instead of an enum check?

`CREATE UNIQUE INDEX ... WHERE kind='tower_system'` enforces "at most one
Tower channel" at the DB layer. A check constraint can't express "max one row"
— would need a trigger. Partial unique index is the standard PG pattern.

Future multi-workspace scoping replaces this with `(workspace_id, kind)`.

## Why don't we add a new `msg_type='tower'`?

Considered. Rejected because:
- Adding to `VALID_MSG_TYPES` ripples to every consumer of the union type
- Frontend renders tower messages by `metadata.persona='tower'` already
- `msg_type='system'` already means "system-sourced" — semantically correct

We may revisit if we need DB-level filtering of Tower posts (e.g. for digest
aggregation queries). At that point a column index on metadata->>'persona'
suffices anyway.

## Why is `postToTowerChannel` the *only* posting path?

Schedulers/runners/proactive monitors will all funnel through this. Single
helper means:
- One place to enforce severity contract (L1 → silent)
- One place to inject persona metadata
- One place to add throttling / dedup logic later (Phase 6 quality loop)

If you find yourself writing `sendMessage(towerRoomId, ...)` directly,
stop — use this helper instead.

## Why `sender_id = NULL`?

Tower is system-sourced — no user owns the post. The frontend renders the
persona avatar based on `metadata.persona` regardless. Using a synthetic
`sender_id` (e.g. -1) would clutter the users table or force special-casing
in lookupUsername.

## Why ensure runs at startup (not on first post)?

- Idempotent: cheap to verify on every restart
- Predictable: posts can fail loud if pre-condition isn't met
- Visibility: log line makes channel state observable in pm2 logs

The trade-off: cold start adds ~one query. Acceptable.

## Why does `ensureTowerChannel` add admins as `'admin'` but skip non-admins?

Admins already auto-join all rooms via `listRooms` (room-manager.ts). Adding
them explicitly is belt-and-suspenders for future code paths that don't
go through `listRooms`. Non-admin auto-add is deferred to Phase 2 — see
implementation plan.
