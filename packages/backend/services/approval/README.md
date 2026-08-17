# Approval Cards

Owns the DB-canonical submission and review lifecycle for results handed from an AI team member or human to one accountable approver.

## Public API

- `createApprovalCard()` — create card, first revision, attachments, and submitted event in one transaction.
- `listApprovalCards()` / `getApprovalCard()` — ACL-filtered projections for My Work and Session surfaces.
- `resolveApprovalCard()` — approve, request changes, or reject with optimistic status checks and attachment integrity verification.
- `resubmitApprovalCard()` — append a new revision after changes were requested.

## Invariants

- Project = Agent Workspace = Primary AI team member identity anchor (1:1).
- Approval DB state is the source of truth. My Work and Session render this state; they do not store another status.
- A normal chat question is not an Approval Card. Cards are explicit, accountable result submissions.
- MVP has one human approver. Approval does not automatically execute external actions or resume an automation.
- File attachments are hashed at submission and rechecked before approval. Changed files make the card stale.
- Card access never implies attachment access; project/session/file ACL is rechecked when creating, reading, and resolving.
