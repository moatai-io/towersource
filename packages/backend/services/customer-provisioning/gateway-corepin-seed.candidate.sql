-- Review-only supplemental seed. Route exists in Router; do not enable automatically.
INSERT INTO gateway_profile_catalog_entries(profile_id,api_id,display_name,route_prefix,capability,cost_meter,enabled)
VALUES('tower-shared-api-v1','corepin','Corepin','/corepin','document_parse','credits',false)
ON CONFLICT(profile_id,api_id) DO NOTHING;
