-- 127: Preserve pre-Harness Pi Session semantics and make binding FK replay-safe.

ALTER TABLE project_agent_harness_bindings
  DROP CONSTRAINT IF EXISTS project_agent_harness_current_revision_fkey;
ALTER TABLE project_agent_harness_bindings
  ADD CONSTRAINT project_agent_harness_current_revision_fkey
  FOREIGN KEY(project_id,current_revision)
  REFERENCES agent_harness_binding_revisions(project_id,revision) ON DELETE RESTRICT;

-- Sessions created before the Harness registry existed had the legacy full Pi surface.
-- Pin only those historical Sessions. Sessions created after migration 120 already pin
-- at creation (or lazily on their first run), so their Project binding must remain valid.
INSERT INTO session_runtime_snapshots(
  session_id,project_id,harness_id,harness_version,runtime_profile_id,
  runtime_profile_version,engine,snapshot,snapshot_hash,source,pinned_at
)
SELECT s.id,s.project_id,'tower-default',1,'standard',1,'pi',
  '{"allowedModels":null,"capabilityIds":[],"defaultModel":null,"engine":"pi","id":"tower-default","networkMode":"platform-default","prompt":{"fragments":[],"includeAgentIdentity":true,"includeMemory":true,"includePlatformKernel":true,"includeProjectInstructions":true,"includeSkills":true},"runtimeProfileId":"standard","runtimeProfileVersion":1,"sandboxMode":"platform-default","source":"legacy-default","version":1}'::jsonb,
  'd6c9f8494b9a418889d98677d25425e3925a4346c5ce3bf1b7428af91fa288b6',
  'legacy-backfill',NOW()
FROM sessions s
CROSS JOIN LATERAL (
  SELECT applied_at FROM _migrations WHERE version='120_agent_harness_registry' LIMIT 1
) rollout
WHERE s.engine='pi'
  AND s.created_at < rollout.applied_at
  AND NOT EXISTS(SELECT 1 FROM session_runtime_snapshots snap WHERE snap.session_id=s.id)
ON CONFLICT(session_id) DO NOTHING;
