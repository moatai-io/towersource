# Single active account transition

Status: initial local implementation; not deployed or browser-E2E verified.

One browser profile shares one active credential. The account-switch menu uses sign-out followed by a fresh sign-in, not a multi-token account vault. The user receives a save-your-work warning. Logout awaits the server response before clearing local identity mirrors; failure leaves the current login intact. Ordinary login and OTP success restart the shell at `/` to rebuild module-level stores. First-admin setup retains its onboarding flow.

App listens for token storage changes and rechecks on focus. Cross-tab changes restart the shell without reusing a previous session URL. Browser navigation tears down the old document and its connections; it does not cancel server AI runs. Stale auth-check/session-list responses cannot clear newer credentials. Bootstrap store writes check their credential. Debounced file-tab persistence is pinned to the module's original owner.

Verification: `account-transition.test.ts`, `account-transition.source.test.ts`, and `../hooks/useAppBootstrap.source.test.ts`. Source assertions are not browser behavior tests.

Remaining before release:
- Two-tab browser tests with delayed logout/login/OTP responses, failed logout and competing tab logins. Concurrent server Set-Cookie responses still require a cross-tab auth-mutation coordination design.
- Audit all per-user persistence, shared drafts, secondary file viewer/recording routes and async callbacks; App listeners do not cover every standalone route.
- Verify cross-tab unsaved edits and account-change notification UX. Current warning is on the initiating tab, not a multi-tab draft preservation protocol.
- Measure reported rendering delay independently; no performance cause has been established.
- No backend permission changes, OTP pilot changes, deployment or server restart are included.
