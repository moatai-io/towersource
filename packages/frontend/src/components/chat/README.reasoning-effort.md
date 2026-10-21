# Session reasoning effort

`SessionReasoningSelector.tsx` provides an optional Pi-session override inside the composer model selection menu. The model list comes first. Choosing a same-engine model keeps the menu open, refreshes the capability-backed effort options, and lets the user choose reasoning second; saving effort closes the menu. Engine switches retain their confirmation flow.

- **Model default** stores `NULL` and follows the selected model's current VM default on every subsequent turn. The label appears under an explicit “Reasoning for this session” heading rather than as a standalone status-line control.
- The selector reads `reasoningEfforts` from the exact selected runtime model and only displays supported product values. Current OpenAI Responses routes expose `low`, `medium`, `high`, `xhigh`, and `max`; non-reasoning models hide the selector.
- A selected effort persists on the Session and takes precedence over the VM model default. Switching to a model that does not support the stored effort clears the override.
- The preference applies to the next turn; it does not alter an already running response or historical usage.
- A failed PATCH rolls the optimistic UI value back.
- Session participants who may edit session metadata may change this preference. This is a shared Session setting, not a private browser preference.
- The frontend includes the persisted value in each chat payload. The backend also falls back to the persisted DB value for non-browser and compatibility callers.

Implementation: `SessionReasoningSelector.tsx`, `StatusLine.tsx`, `useChatRuntime.ts`, backend `routes/api.ts`, `routes/ws-handler.ts`, `services/session/session-manager.ts`, `services/model-policy/reasoning-efforts.ts`, `engines/pi/model-registry.ts`, migration `231_session_reasoning_effort.sql`.

Verification: colocated source-contract tests, migration test, backend/frontend type checks, and existing reasoning-default tests. Deployment and live provider verification are separate.
