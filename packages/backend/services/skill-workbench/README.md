# skill-workbench

Owns: internal Beta skill comparison runs for Tower operator dogfooding.

## Public API

- `isSkillWorkbenchEnabled()` — returns whether this VM may expose the Beta workbench.
- `buildSkillWorkbenchPrompt()` — builds the stateless prompt/system prompt for one comparison arm.
- `runSkillWorkbenchComparison()` — runs Skill off / Draft skill / Baseline skill via utility quick replies.
- `listSkillWorkbenchHistory()` — reads recent user-visible comparison runs.
- `listSkillWorkbenchTestCases()` / `saveSkillWorkbenchTestCase()` / `deleteSkillWorkbenchTestCase()` — manage reusable prompt cases.

## Boundaries

- This is **full VM only** (`TOWER_ROLE=full`). Customer `managed` VMs must not expose the UI or API.
- Phase 1 uses stateless utility quick replies, not persisted Tower sessions, to avoid sidebar noise and chat context contamination. All three comparison arms use the current Core mapping (`defaults.session`): the utility transport does not make the workload a Lite job. `skill-workbench.test.ts` verifies model delivery through mocked utility calls without writing history or calling a provider.
- Skill content is bounded before being prepended so draft/baseline tests cannot accidentally create unbounded prompts.
- History/test cases are stored under backend data (`data/skill-workbench/*.json`) and tagged by `ownerUserId` for user-visible filtering. Older unowned Beta rows remain visible on the internal VM during transition.
- Current scoring is deterministic heuristic scoring for quick triage, not a final LLM-judge quality verdict.
