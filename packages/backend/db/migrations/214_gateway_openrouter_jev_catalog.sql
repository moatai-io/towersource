-- 214_gateway_openrouter_jev_catalog.sql
-- Register the OpenRouter Jev Decisions route in the shared Gateway Profile catalog.

INSERT INTO gateway_profile_catalog_entries
  (profile_id, api_id, display_name, route_prefix, capability, client_base_env, cost_meter, quota_mode, readiness, metadata)
VALUES
  (
    'tower-shared-api-v1',
    'openrouter-jev',
    'OpenRouter Jev Decisions',
    '/inference/openrouter',
    'decision_evaluation',
    NULL,
    'tokens',
    'observe',
    'unverified',
    '{"endpoint":"/api/alpha/decisions","model":"typesafe/jev-1.13"}'::jsonb
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
