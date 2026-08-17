-- Phase 6 follow-up — retire sticky OpenRouter and Azure GPT-5.4 Pi session models.
--
-- Azure GPT-5.5 can remain as a manual/emergency route, but GPT-5.4 and
-- OpenRouter/Moonshot-era rows should no longer be inherited by active sessions.
-- Archived sessions are preserved as historical records.

UPDATE sessions
SET model_used = 'litellm-responses/smartest'
WHERE engine = 'pi'
  AND archived = 0
  AND (
    model_used = 'azure-openai-responses/gpt-5.4'
    OR model_used LIKE 'openrouter/%'
  );
