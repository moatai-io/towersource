-- Register only; applying this migration requires normal deployment approval.
INSERT INTO gateway_profile_catalog_entries
  (profile_id, api_id, display_name, route_prefix, capability, cost_meter, quota_mode, readiness, metadata)
VALUES ('tower-shared-api-v1', 'text-to-speech', 'Korean Answer Speech', '/text-to-speech/with-timestamps', 'speech', 'characters', 'observe', 'unverified',
  '{"defaultModel":"eleven_v4","voiceId":"DkAJhrMznCtWh38YrjTv","language":"ko","alignment":"characters"}'::jsonb)
ON CONFLICT (profile_id, api_id) DO NOTHING;
