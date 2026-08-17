# skill-workbench decisions

- Start as `TOWER_ROLE=full` only. Frontend hiding is convenience; backend route gating is the security boundary.
- Phase 1 compares outputs with stateless utility quick replies. Real isolated sessions are more faithful but add lifecycle, cleanup, and sidebar-noise risk.
- Skill instructions are injected as bounded text into the system prompt for draft/baseline arms. The workbench should help humans compare behavior, not become a general eval runner yet.
