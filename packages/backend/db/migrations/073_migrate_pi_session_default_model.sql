-- Phase 6 — Pi session model cleanup after litellm-responses/smartest became the
-- configured session default.
--
-- Active Pi sessions that still point at retired transition-era providers should
-- resume on the configured Smartest route instead of silently re-entering direct
-- Codex/OAuth paths. Archived sessions are left untouched as historical records.

UPDATE sessions
SET model_used = 'litellm-responses/smartest'
WHERE engine = 'pi'
  AND archived = 0
  AND (
    model_used IS NULL
    OR model_used = ''
    OR model_used LIKE 'claude-%'
    OR model_used IN (
      'openai-codex/gpt-5.5',
      'codex-lb/gpt-5.5',
      'litellm/codex-lb-gpt-5.5',
      'litellm/smartest'
    )
  );
