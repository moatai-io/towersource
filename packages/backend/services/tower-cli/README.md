# Tower CLI surface

Owns the phase-1 external AI command contract for Tower.

## Public contract

The user-facing command shape is:

```text
tower auth login --username <name>
tower auth token import [--token <tower-cli-token> | stdin]
tower auth status
tower projects list
tower files list/read/write
tower tasks create/list
```

## Client/server boundary

`tower` is a **remote client CLI**. It runs on a user workstation or inside an external AI tool environment and talks to a Tower SaaS/server instance over HTTP.

It must not import backend services, database helpers, or server filesystem modules. A local machine running `tower` should only need:

- a Tower instance URL (`--url` or `TOWER_URL`), and
- a scoped CLI token saved in `~/.tower/cli.json`.

It must not require `DATABASE_URL`, server `.env`, the Tower repo checkout, or direct access to the server workspace filesystem.

## Server authority

The Tower server remains the authority boundary:

- `tower auth login` prompts for a hidden password in an interactive TTY, calls the server, and receives an audience-scoped `tower-cli` token.
- CI and other automation import an already-issued scoped token with `tower auth token import`; they must not pass account passwords through argv, env vars, or password stdin.
- Project, file, and task commands call existing server API routes.
- Server-side ACL, project membership, dotfile/system path guards, and write checks stay authoritative.
- `tower files write` is dry-run by default and only mutates with `--confirm`.

Search, publish, delete, deploy, and broad admin operations are intentionally out of phase 1.

## Server/internal CLI

If an in-process maintenance helper is useful, keep it under an explicit server/internal name such as:

```text
npm run tower:server
```

That script may import backend modules and require `DATABASE_URL`, but it is not the user-facing client CLI.

## Future MCP adapter

The future local MCP adapter should wrap these CLI commands instead of defining a separate authority model. Tool names should remain split by risk, e.g. `files_read` and `files_write` rather than a single broad file tool.

## Related decisions

- `~/workspace/decisions/2026-07-03-tower-scoped-cli-first-external-ai-surface.md`
- `~/workspace/decisions/2026-07-06-tower-cli-remote-client-boundary.md`
