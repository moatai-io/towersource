# Managed publication contract — initial foundation

Tracks the proposed common identity used by Agent Hub, global Hub and Control room. This is an isolated foundation, NOT yet wired into persistence, publish_site, Hub routes or UI. Do not accept these TypeScript interfaces as validated API input. Owner identity must be server-bound and all referenced datasets/services require authorization.

`ManagedPublication` separates an immutable artifact revision from dataset and service references. Project IDs, not mutable names/folder keys, express ownership. Existing static publishing manifests remain unchanged; legacy identity migration requires explicit unambiguous mapping and must not guess.

`datasetHealth` derives freshness from the source timestamp. Recent job completion cannot make old source data fresh. Failure and running states remain distinct. Consumers should display source and last-success timestamps alongside health; no user-supplied metadata is proof of actual execution.

The registry must eventually back all three views, but this foundation does not replace the current manual control-room.json. Required next integration work: persistent validated metadata, legacy mapping, server ACL-filtered listing, Agent filter, actual artifact opening and tests. Internal authenticated publication and service activation require separate contracts; unlisted URLs are not authorization.

Test: `npx vitest run packages/shared/publishing/managed-publication.test.ts`.
