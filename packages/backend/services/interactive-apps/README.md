# Interactive apps — experimental authority core

Status: pre-integration prototype, not a shipped feature.

`app-authority.ts` checks immutable instance ownership (user, Project, session), the intersection of requested and server-approved read capabilities, and current access both before execution and before returning a result. Revocation during execution suppresses result disclosure.

The caller must obtain the principal from authenticated server context, supply a real current-access policy, and select an executor from a server-owned, schema-validated read-only registry. Never accept an executor, policy allowlist, or principal from app messages. `callRead` does not establish that a function is read-only.

This module is not yet wired to HTTP routes, the Viewer, engine tools, production ACL, or conversation submission. Instances are in-memory; restart persistence, expiry, quotas, argument validation, audit, and idempotent selection submission remain required. Do not enable it for real data.

Validation:

```sh
npx vitest run packages/backend/services/interactive-apps/app-authority.test.ts
node experiments/sideview-app-spike/verify.cjs
```

Product proposal: `docs/plans/sideview-interactive-apps-prd.md`.
