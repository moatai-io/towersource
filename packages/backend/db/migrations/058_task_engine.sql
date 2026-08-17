-- ============================================================
-- 058: Task engine column
--
-- Lets a task pick which Engine (claude / pi / local) runs it.
-- Previously task-runner.ts hard-coded executeQuery (Claude) so
-- the engine selector in the UI was silently inert for Pi.
--
-- Default 'claude' preserves behaviour for all existing rows and
-- for any callers that don't yet pass an engine.
--
-- Model semantics stay the same — `tasks.model` is still the wire
-- model id ('claude-opus-4-7', 'openrouter/moonshotai/kimi-k2.6',
-- 'azure/gpt-5.5', etc). Engine + model are independent because
-- the same engine accepts multiple models (Pi handles both
-- OpenRouter and Azure routes).
--
-- See:
--   workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md
--   workspace/projects/piagent/parity-roadmap-2026-05.md (W2)
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';

-- Existing rows keep 'claude' from the DEFAULT — no UPDATE needed.
