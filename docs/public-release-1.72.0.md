# Public source candidate 1.72.0

This is a source-only update for self-hosted installations. Publication and live deployment are separate actions.

## Included scope

The current application source includes Agent workspaces, session access and audience boundaries, personal model connection selection, execution tooling, and current installation documentation. Operator fleet tooling, private infrastructure records, generated runtime data, and source Git history are excluded.

## Public-build fixes

- Refresh stale source assertions against current routing, session access, and authentication contracts while retaining access-control checks.
- Restore deterministic initial focus in the inline team-change review panel and preserve cancellation focus restoration.
- Test cross-layer boundaries on shipped modules, allowing deliberate cross-layer test fixtures.
- Isolate MCP loader unit tests from live project access storage; integration access tests remain separate.
- Update vulnerable dependencies, use the official SheetJS 0.20.3 tarball with lockfile integrity, and remove unused patch-package.
- Update React Router to 7.18.4, Vitest to 4.1.12, and the MCP SDK to the patched 1.32 line.
- Keep private deployment contracts outside public CI; run public unit/source tests, typecheck, dialog lint and build in CI.

## Executed checks

- Clean dependency installation and postinstall passed.
- Dependency graph validation passed.
- Full test suite: 1,638 files passed, 44 skipped; 10,448 tests passed, 2 expected failures and 324 skipped. Skipped coverage is not represented as verified behavior.
- Typecheck, dialog lint and frontend/backend build passed.
- npm audit: 0 critical, 0 high, 0 moderate, 10 low. Remaining low findings include KaTeX defense-in-depth behavior conditional on pre-existing prototype pollution.
- Public source-pattern review: no unreviewed findings; four exact-location reviewed validation/synthetic-fixture exceptions. Pattern checks are not a guarantee against every secret.

No live installation upgrade or remote production verification was performed. Test fixtures do not prove provider account availability or every deployment environment.
