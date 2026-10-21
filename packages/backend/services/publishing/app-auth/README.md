# App authentication security spike — not a login service

Tests the semantics of a 60-second one-time code, S256 PKCE verifier, audience-bound five-minute opaque app session, live authorization and logout revocation. Only hashes of codes/tokens are held internally. Revocation invalidates concurrent issuance/exchange conservatively. Memory is bounded and expiry is cleaned during issuance. No Tower credential is delegated.

NOT wired to routes, real user policy, app registry, cookies or public publishing. Not OIDC and not production SSO. Do not deploy this as a custom identity provider. Production design should evaluate an established OIDC provider/library before expanding authentication implementation.

Before any browser integration: server-owned exact app/callback allowlist; real Tower session and logout validation; state/CSRF and PKCE binding; separate app origin; HttpOnly Secure host-only cookies (no wildcard parent-domain cookies); backend-only exchange; authenticated HTML/assets/API; cache isolation; rate limits and redacted audit; atomic shared ticket storage if multiple workers; browser E2E for logout/access revocation and back navigation. A copied identity type is not an authorization grant. The policy callback must validate the actual upstream session, app, Project and dataset access, not just membership.

Tokens returned by this internal spike are intended for a future server-side exchange only, never generated app JS or URL query tokens. Unlisted publishing is unchanged and remains publicly reachable by link.
