# Decisions

- Configuration changes create a new immutable version.
- Approval never executes deployment.
- Pause preserves the current deployment pointer.
- Rollback activates an approved or superseded version.
- Revoke is terminal and blocks serving channels.
