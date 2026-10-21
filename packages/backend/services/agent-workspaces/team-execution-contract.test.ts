import { expect, it } from 'vitest';
import { workbenchExecutionRequestDigest } from '../runtime-box/workbench-project-execution-grant.js';
import type { RemoteWorkbenchJobSpec } from '../execution/remote-job-runner.js';
import { assertTeamExecutionContract } from './team-execution-contract.js';
const spec: RemoteWorkbenchJobSpec = { jobId: 1, projectId: 'a', actorUserId: 1, command: 'true', environmentKeys: [], workbenchRevision: 1 };
const teamMountContext = { agentProjectId: 'a', deploymentId: 'test', teamId: 'team-a', mounts: [
  { workspaceId: 'a-files', source: '/registered/a', target: '/workspace', readOnly: false },
] };
const input = { spec, teamMountContext, executionBackend: 'legacy' as const, isolationProfile: 'project-sandbox-v1' as const };
it('documents that the current execution-grant digest does not bind unknown team fields', () => {
  expect(workbenchExecutionRequestDigest({ ...spec, teamMounts: teamMountContext.mounts } as RemoteWorkbenchJobSpec)).toBe(workbenchExecutionRequestDigest(spec));
});
it('preserves baseline legacy behavior only when no team plan or unknown spec fields are present', () => {
  expect(() => assertTeamExecutionContract({ ...input, teamMountContext: null })).not.toThrow();
});
it('rejects installed native execution even with the project sandbox profile configured', () => {
  expect(() => assertTeamExecutionContract({ ...input, executionBackend: 'installed-executor' })).toThrow('TEAM_EXECUTION_NATIVE_UNSUPPORTED');
});
it('requires the canonical project sandbox rather than skill-dependent sandbox selection', () => {
  expect(() => assertTeamExecutionContract({ ...input, isolationProfile: 'legacy-skill-dependent' })).toThrow('TEAM_EXECUTION_SANDBOX_REQUIRED');
});
it('rejects canonical bwrap execution too: existing shell/job capabilities are not exact team mount support', () => {
  expect(() => assertTeamExecutionContract(input)).toThrow('TEAM_EXECUTION_CAPABILITY_UNSUPPORTED');
});
it('does not interpret an empty team plan as teamless', () => {
  expect(() => assertTeamExecutionContract({ ...input, teamMountContext: { ...teamMountContext, mounts: [] } })).toThrow('TEAM_EXECUTION_CAPABILITY_UNSUPPORTED');
});
it('binds the running project reference before checking executor support', () => {
  expect(() => assertTeamExecutionContract({ ...input, spec: { ...spec, projectId: 'other' } })).toThrow('TEAM_EXECUTION_CONTEXT_MISMATCH');
});
it.each(['teamMounts', 'teamId', 'mounts', 'executionCapability', 'futureExtension'])('rejects unknown spec field %s instead of silently dropping it', field => {
  expect(() => assertTeamExecutionContract({ ...input, teamMountContext: null, spec: { ...spec, [field]: [] } })).toThrow('TEAM_EXECUTION_SPEC_UNSUPPORTED');
});
it('accepts all current Remote spec field names without adding a new wire schema', () => {
  expect(() => assertTeamExecutionContract({ ...input, teamMountContext: null, spec: { ...spec,
    lifecycle: 'service-control', sessionId: '00000000-0000-0000-0000-000000000001', workspaceId: 'prepared', cwd: '.', timeoutSec: 30, artifacts: [{ path: 'result.txt' }],
  } })).not.toThrow();
});
it('rejects service/prepared-workspace team execution rather than substituting the own root', () => {
  expect(() => assertTeamExecutionContract({ ...input, spec: { ...spec, lifecycle: 'service-control' } })).toThrow('TEAM_EXECUTION_SPEC_UNSUPPORTED');
  expect(() => assertTeamExecutionContract({ ...input, spec: { ...spec, workspaceId: 'prepared' } })).toThrow('TEAM_EXECUTION_SPEC_UNSUPPORTED');
});
