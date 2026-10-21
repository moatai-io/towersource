# Session list UI

`SessionItem.tsx` owns session rows and their shared desktop context menu / mobile action sheet.

## Long-context menu retirement

The legacy long-context toggle is no longer exposed in the session action menu after the move to Astra. Both “Use long context” and “Restore normal context” actions, along with their row-level mutation handler and pending indicator, are removed.

This is a UI-only change: existing `modelUsed` values, backend routing, the `long-context-toggle.ts` compatibility helper, and the `LONG` badge for previously configured sessions remain unchanged. No stored sessions are migrated.

Regression coverage:
- `SessionItem.context-menu.source.test.ts`: menu omission and removal of mutation wiring; positioning and other menu contracts.
- `SessionItem.presentation.source.test.ts`: existing row presentation, including the legacy `LONG` badge.
- `long-context-toggle.test.ts`: retained compatibility helper.

These are source-contract and helper tests, not live browser or deployment verification.

## Delete action icon

Session-row delete buttons and their shared context-menu/mobile-sheet actions default to a trash icon. Sidebar latest-session rows explicitly use the same icon. Explicit archive actions retain the archive icon, and inbox read-state actions retain the down-chevron override.

This changes only presentation; session archival, recovery, endpoints, and confirmation copy are unchanged. Regression coverage: `session-archive-copy.source.test.ts` (source contracts, not live browser verification).
