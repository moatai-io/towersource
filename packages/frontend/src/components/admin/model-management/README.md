# Admin AI model settings

`ModelManagement.tsx` owns the admin AI tab: Core work / Lite utility model defaults, LiteLLM catalog discovery and refresh, router connection status, and inference readiness display. `AdminPanel.tsx` owns only tab authorization and routing. `ModelDefaultSelect.tsx` is a sibling UI control that preserves the persisted model ID even when it is absent from a refreshed catalog; do not silently select the first available model.

The AI tab is visible to admin/operator roles; the reasoning selector is read-only for operators and writes require backend admin authority. Model discovery failures lock changes rather than guessing a replacement. Refresh and default-selection writes still use the existing admin API paths. The per-model reasoning selector lists discovered reasoning models and mapped defaults; its separate admin-only PATCH `/api/admin/models/reasoning` changes only `defaultReasoning` in the VM-local `models.json`, without rewriting workload policy effort or routing. Explicit per-run effort overrides the model default. A running turn keeps its current thinking level; a newly created or resumed Pi session reads the updated default at its next turn. The form does not imply provider acceptance until a live turn is verified.

Verification: `AdminPanel.ai-operations.source.test.ts`, `AdminPanel.inference-wizard.source.test.ts`, `AdminPanel.responsive-layout.source.test.ts`, `ModelDefaultSelect.test.tsx`, and the frontend typecheck. Source tests inspect the owning module for behavior and `AdminPanel.tsx` for tab wiring; they are not a substitute for an authenticated browser smoke test.

## Core work and Lite utilities

- **Core** (`defaults.session`) is the default for conversations, agent work, automation, scheduled Tasks, proactive work without an explicit model, and Skill Workbench comparisons.
- Admins and Operators can change each reasoning-capable model's VM default effort in this panel. The backend endpoint enforces Operator-or-higher authority, and validates the value against that model's explicit `reasoningEfforts` capability list.
- The dropdown does not use a global fixed list. Current OpenAI Responses routes declare `low`, `medium`, `high`, `xhigh`, and `max`; models with a narrower contract only show their declared values. The Pi registry receives the same capability as `thinkingLevelMap`, preventing SDK-side silent clamping.
- **Lite** (`defaults.ai_task`, with `defaults.ai_reply` synchronized by the save API) is the compatibility slot for short utility work such as title generation and short summaries. The `ai_task` field name does not designate automation execution.
- The status summary and editable rows use the same Core/Lite labels. Admin diagnostics display automation/background defaults from `defaults.session`, not the Lite slot.
- Explicit existing Task/Automation/Agent model choices remain explicit. These labels do not promise a bulk conversion of saved jobs or historical runs.
- Conversation compaction has a separate execution path. This UI change does not configure, implement, or verify compaction model switching or prompt caching.
- Saving Core updates the logical `background` policy alongside the other Core policies; saving Lite updates `low/title/summary`. Legacy `background` model references resolve to current Core without changing their effort or enabled flags.

Implementation: `ModelManagement.tsx`, `../AdminPanel.tsx`, `../../../locales/{ko,en}/admin.json`, backend `routes/api.ts`, `services/model-policy/model-policy.ts`.

Verification: `../AdminPanel.ai-operations.source.test.ts` checks labels and field ownership; backend `services/model-policy/model-policy.test.ts` checks runtime resolution and `services/task/task-default-core.source.test.ts` checks save/default wiring. These local tests do not constitute deployment or live browser/provider verification.
