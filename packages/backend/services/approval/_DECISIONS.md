# Approval Card decisions

- Keep Approval Card as an independent DB object instead of embedding mutable state in Session messages or WorkLedger rows.
- Use a single approver for MVP; multi-step approval routing is deferred.
- Treat approval as a recorded signal, not proof that an external action executed. Execution status remains separate.
- Store immutable revisions and append-only events; update only the card's current projection fields.
- Require a Project/Agent Workspace for MVP so ACL, files, Primary AI team member, and runtime context have one boundary.
