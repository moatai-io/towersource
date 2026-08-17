-- Pi model alias cleanup after Tower standardized on LiteLLM Responses routes.
--
-- Runtime-visible model catalog is now:
--   - litellm-responses/smartest  (session + automation default)
--   - litellm-responses/mini      (utility/task default)
--   - azure-openai-responses-eastus2/gpt-5.5 (full-VM emergency only)
--
-- Retired routes include bare aliases (fast/balanced/smartest/smart/mini),
-- legacy LiteLLM Chat Completions aliases, direct Codex/OpenRouter routes, and
-- Claude defaults for task/schedule/automation runtime queues. Archived sessions
-- remain historical records; active Pi sessions are normalized on resume.

ALTER TABLE tasks
  ALTER COLUMN model SET DEFAULT 'litellm-responses/mini';

ALTER TABLE schedules
  ALTER COLUMN model SET DEFAULT 'litellm-responses/smartest';

ALTER TABLE automations
  ALTER COLUMN model SET DEFAULT 'litellm-responses/smartest';

-- Active Pi sessions should never keep sticky retired provider/model IDs.
UPDATE sessions
SET model_used = 'litellm-responses/smartest'
WHERE engine = 'pi'
  AND archived = 0
  AND (
    model_used IS NULL
    OR model_used = ''
    OR model_used LIKE 'claude-%'
    OR model_used LIKE 'openrouter/%'
    OR model_used IN (
      'fast',
      'balanced',
      'smartest',
      'smart',
      'mini',
      'openai-codex/gpt-5.5',
      'codex-lb/gpt-5.5',
      'litellm/codex-lb-gpt-5.5',
      'litellm/smartest',
      'litellm/smart',
      'azure-openai-responses/gpt-5.4'
    )
  );

-- Task runner defaults to mini. If a legacy row is rerun, route it through Pi/mini.
UPDATE tasks
SET engine = 'pi', model = 'litellm-responses/mini'
WHERE model IS NULL
   OR model = ''
   OR model LIKE 'claude-%'
   OR model LIKE 'openrouter/%'
   OR model IN (
      'fast',
      'balanced',
      'smartest',
      'smart',
      'mini',
      'openai-codex/gpt-5.5',
      'codex-lb/gpt-5.5',
      'litellm/codex-lb-gpt-5.5',
      'litellm/smartest',
      'litellm/smart',
      'azure-openai-responses/gpt-5.4'
   );

-- Schedules and automations are session-like recurring work; default to Smartest.
UPDATE schedules
SET model = 'litellm-responses/smartest'
WHERE model IS NULL
   OR model = ''
   OR model LIKE 'claude-%'
   OR model LIKE 'openrouter/%'
   OR model IN (
      'fast',
      'balanced',
      'smartest',
      'smart',
      'mini',
      'openai-codex/gpt-5.5',
      'codex-lb/gpt-5.5',
      'litellm/codex-lb-gpt-5.5',
      'litellm/smartest',
      'litellm/smart',
      'azure-openai-responses/gpt-5.4'
   );

UPDATE automations
SET model = 'litellm-responses/smartest'
WHERE model IS NULL
   OR model = ''
   OR model LIKE 'claude-%'
   OR model LIKE 'openrouter/%'
   OR model IN (
      'fast',
      'balanced',
      'smartest',
      'smart',
      'mini',
      'openai-codex/gpt-5.5',
      'codex-lb/gpt-5.5',
      'litellm/codex-lb-gpt-5.5',
      'litellm/smartest',
      'litellm/smart',
      'azure-openai-responses/gpt-5.4'
   );
