-- Catalog registration only: no credential values and no live readiness claim.
INSERT INTO gateway_profile_catalog_entries
  (profile_id, api_id, display_name, route_prefix, capability, cost_meter, quota_mode, readiness, metadata)
VALUES ('tower-shared-api-v1', 'speech-to-text', 'Korean Speech to Text', '/speech-to-text', 'transcription', 'audio_minutes', 'observe', 'unverified',
  '{"defaultModel":"gpt-transcribe","language":"ko","pricing":{"currency":"USD","unit":"audio_minute","providerUnitPrice":0.0045,"kind":"published","source":"https://developers.openai.com/api/docs/models/gpt-transcribe","excludes":["gateway","tax"],"requiresRecheck":true}}'::jsonb)
ON CONFLICT (profile_id, api_id) DO UPDATE
SET route_prefix = EXCLUDED.route_prefix,
    metadata = gateway_profile_catalog_entries.metadata || EXCLUDED.metadata,
    updated_at = NOW();
