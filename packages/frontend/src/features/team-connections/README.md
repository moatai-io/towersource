# People and AI connections

AI Team home embeds a compact, flat people/agent relationship overview. There is no reporting hierarchy or inferred manager relationship between Agents.

## Contract

- Source: current VM's authenticated `/api/users/search?q=` (existing active-user directory, up to 1000 users) and `/api/projects/:id/members` for visible active non-system Projects. Member lookup is bounded to four concurrent requests and cancelled on unmount or scope change.
- Existing member-list ACL remains authoritative. No new backend endpoint, role escalation, schema, VM identifiers or seeded organization data.
- Connection means explicit Project membership, including read-only membership. It is **not** conversation history, actual use, global admin/operator access, company job title, or inferred project ownership. The existing API does not expose global user roles, so this surface does not invent role labels.
- Membership failures/denials remain unknown, not zero. The directory includes people without a confirmed connection. Counts cover only successfully read memberships in the visible Project scope.
- One static SVG dot matrix: all people are rows, all active accessible AI are columns. Only registered memberships produce dots. Unknown columns are shaded and marked `?`; they are never presented as absent memberships.
- No person selection, search, graph mode, relationship curves or agent navigation in the overview. All coordinates scale together inside a height-bounded SVG, with no cropped rows or columns. At large populations labels intentionally become small: this is a whole-team density overview, not a detailed editing surface.
- SVG titles identify names and connections; an optional text list makes the same data readable without relying on tiny dots. The existing detailed AI directory remains below.
- Refresh on mount, Project ID scope changes, window focus, or explicit refresh. No background polling. Bounded scroll areas prevent large organizations from consuming the whole home.
- Same code reads local data on each VM after that VM receives this release; this change does not deploy to other VMs or aggregate cross-VM identities.

## Verification

`TeamConnections.test.tsx` tests whole-team inclusion, static matrix geometry, membership-only dots, unknown columns, refresh and errors. `data.ts` owns read-only loading; `TeamConnections.tsx` owns presentation; integration is in `../../components/agents/AITeamHome.tsx`.

Live authenticated VM verification is separate from component tests and compilation.
