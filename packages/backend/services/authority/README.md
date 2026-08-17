# Authority services

Owns lightweight authorization policy helpers that sit above raw role checks and below product workflows.

## Public API

- `execution-gate.ts` — evaluates whether a project member may execute an action from a project/Runbox context.

## Design intent

This module intentionally starts small. It is not a new heavyweight permission system. It codifies the current direction:

> Project membership grants normal execution inside the project package. Admin/owner controls who enters the project and which credentials/policies are attached.

The gate returns `allow`, `deny`, `needs_setup`, or `needs_confirmation` so callers can keep existing UX/preflight flows while using one shared policy vocabulary.

## See also

- `~/workspace/decisions/2026-06-20-projects-as-preconfigured-runbox-deployments.md`
- `~/workspace/decisions/2026-06-20-personal-authority-contextual-runbox.md`
- `~/workspace/projects/project-2/docs/runbox-authority/README.md`
