# Work module decisions

- Start with read-only projection from `messages.content` instead of a new table. This makes the first product MVP safe and reversible.
- Use `Project → Challenge/Workstream → segments` as the API shape because the user-facing view is an activity board, not a raw todo list.
- Internally prefer the TodoWrite v3 workstream model: `workstreamKey` is the stable grouping identity, `workstreamTitle` is the user-facing row title, and `runTitle` is the specific turn/run name.
- Migrate legacy v2 records by reading `work.epic` as the workstream identity/title fallback and `work.title` as the run-title fallback. If no work metadata exists, fall back to session name.
- Keep `backlog` and `questions` separate from current-run `todos`; future detail surfaces may show them, but the main timeline should not count them as unfinished todos.
- Treat `messages.created_at` as TodoWrite snapshot time. Do not imply exact human/AI labor duration; merged segments are visualization approximations.
- Respect session privacy by including project sessions for project members only when `sessions.visibility = 'project'`; private sessions remain owner/admin/operator only.
