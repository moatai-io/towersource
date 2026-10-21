# Persistent frontend assets

## Contract

Production startup copies regular content-addressed Vite assets from `frontendDir/assets` into `dataDir/frontend-assets` before registering frontend routes. Backend startup fails if durable publication fails or the same filename has different content. Atomic no-overwrite publication supports concurrent startup. Mutable HTML, runtime configuration, service workers, subdirectories and symlinks are excluded.

`/assets` serves the retained store first, with immutable one-year caching, then the current frontend directory. Missing assets return an uncached 404 rather than the SPA HTML fallback. Existing API, HTML and service worker policies remain unchanged.

The configured data directory **must persist across deployment and rollback**. Replacing the frontend release or deleting its old directory does not remove retained files. There is deliberately no automatic age/count cleanup: a client can return after an arbitrarily long absence. Operators must monitor disk usage and obtain explicit approval for cleanup. Old public JS remains downloadable, so never embed secrets in bundles; emergency withdrawal requires coordinated cache and retention handling.

## Rollout boundary

Retention starts with the first version containing this code. Assets removed before that startup cannot be reconstructed. To cover clients on the immediately preceding version, preserve and seed its `assets` with `retainFrontendAssets(oldFrontendDir, dataDir)` before removing that release. This helper is local-only and performs no deployment or remote writes. Do not point it at untrusted directories.

A backend-only upgrade, frontend artifact switch and rollback must use the same persistent dataDir. Deployments that bypass this backend for static assets (for example, an upstream CDN or separate web server) must configure equivalent retained `/assets` routing; this backend cannot guarantee their behavior.

## Evidence

- Implementation: `retention.ts`, `../../index.ts`.
- Tests: `retention.test.ts` covers release replacement, idempotence, JS/CSS preservation, exclusion, collision refusal and production route ordering.
- Local tests and typechecking do not establish production rollout or real iOS verification.

## App-only cutover integration

`upgrade-operator-app` invokes `scripts/nix-app/retain-previous-frontend-assets.mjs` under the deployment lock before stopping the active process. The helper resolves app-only release, Nix closure and legacy host entrypoints and invokes the new release's compiled retention module against the active frontend. Missing previous assets or an unrecognized entrypoint aborts before process stop. Releases predating retention skip seeding. This integration covers the app-only operator path; other deployment systems must add the same pre-stop seeding step. It has not been executed against production.
