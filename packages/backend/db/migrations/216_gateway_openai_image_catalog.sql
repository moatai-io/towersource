-- OpenAI Image capability uses the shared /openai proxy but keeps readiness and metering separate.

INSERT INTO gateway_profile_catalog_entries
  (profile_id, api_id, display_name, route_prefix, capability, client_base_env, cost_meter, quota_mode, readiness, metadata)
VALUES
  (
    'tower-shared-api-v1',
    'openai-image',
    'OpenAI Image',
    '/openai',
    'image_generation',
    'OPENAI_IMAGE_BASE_URL',
    'images',
    'observe',
    'unverified',
    '{"generateEndpoint":"/images/generations","editEndpoint":"/images/edits","defaultModel":"gpt-image-2.5-sunburst","models":["gpt-image-2.5-sunburst","gpt-image-1"]}'::jsonb
  )
ON CONFLICT (profile_id, api_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    route_prefix = EXCLUDED.route_prefix,
    capability = EXCLUDED.capability,
    client_base_env = EXCLUDED.client_base_env,
    cost_meter = EXCLUDED.cost_meter,
    quota_mode = EXCLUDED.quota_mode,
    metadata = gateway_profile_catalog_entries.metadata || EXCLUDED.metadata,
    updated_at = NOW();
