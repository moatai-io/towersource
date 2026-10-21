# Host-owned interactive UI

Status: pricing JSON preview is wired into ContextPanel and FileViewerPage in source; not deployed or connected to production session submission.

`PricingApp` accepts an unknown declaration, validates it with `packages/shared/pricing-app.ts`, and renders Tower-owned controls. It never interprets HTML, CSS, URLs, functions or expression strings. Titles are escaped React text. Unknown fields are rejected.

`pricing.v1` accepts integer customers (0–1,000,000), integer KRW amounts (0–1,000,000,000) and integer percentage discount (0–100). Intermediate money uses BigInt hundredths of KRW. Display amounts round to nearest KRW, ties away from zero. Unit margin <= 0 has no defined break-even, matching the proposal.

The user must review then confirm a snapshot. Editing invalidates confirmation. A synchronous lock prevents duplicate in-flight callbacks. This does NOT provide durable server idempotency or authenticated authorization. The integration must revalidate/recalculate and bind submission ID, state revision, declaration digest, user, Project and session. After an ambiguous network failure, query submission status before retrying.

Mount with `key=instanceId`; declarations are immutable per instance. `onConfirm` is a trusted host callback, not an AI-declared handler. The renderer currently has Korean labels and requires normal localization integration before general release.

Files ending in `.pricing-app.json` explicitly opt in. Ordinary JSON keeps its existing preview. Malformed/oversized declarations fail closed. In file preview the confirmation button is disabled and the UI explicitly says session submission is not connected. Example: `experiments/sideview-app-spike/demo.pricing-app.json`.

Remaining: engine tool wiring, host error boundary, current ACL and read registry, persistent state, baseline comparison/reset UX, actual session delivery, server idempotency, browser/mobile accessibility and performance verification. No deployment or feature activation has occurred.

Tests:

```sh
npx vitest run packages/shared/pricing-app.test.ts packages/frontend/src/components/interactive-apps/PricingApp.test.tsx
```

Product proposal: `docs/plans/sideview-interactive-apps-prd.md`.

## Dashboard creation tool (Pi)

`create_dashboard` is wired into Pi tool assembly. It accepts a safe lowercase slug and a `pricing.v1` declaration, writes `dashboards/<slug>/dashboard.pricing-app.json` through the existing Project workspace file service, and returns the shared Viewer intent. Same serialized content is idempotent; different existing content is rejected. Session privacy and file write admission are reused. No publishing, permission grants or arbitrary output paths are supported. Saved files can be reopened via the existing file browser/present_file; the AI Team Control room lists explicitly registered dashboards. Claude tool registration is not implemented. Tests mock authority/storage and do not establish live ACL or deployment verification.

## Dashboard list

DashboardList is an unmounted exploratory component; its Files sidebar integration was removed in favor of the AI Team Control room. It lazily enumerates `dashboards/<slug>/dashboard.pricing-app.json` through the existing `/api/files/tree` authority boundary and opens entries through the existing file click handler. The initial label is the saved slug, not the declaration title. Refresh is manual; up to 100 immediate slug folders are scanned sequentially to bound requests. Missing `dashboards` is an empty state, while failed reads are an error, not an empty list. Project changes remount the section and cancel outstanding requests. This is not a separate top-level app route, cross-Project search, favorites, automatic refresh, or data access grant.

Validation: DashboardList component tests cover lazy loading/open, empty folder state, and permission failure. Frontend TypeScript passes. Deployed browser/mobile verification remains outstanding.
