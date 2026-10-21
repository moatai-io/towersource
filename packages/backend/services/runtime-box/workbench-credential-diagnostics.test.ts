import { expect, it } from 'vitest';
import { workbenchCredentialDiagnostics } from './workbench-credential-diagnostics.js';
import type { RemoteWorkbenchCredentialResolution } from './workbench-remote-credential-resolution.js';
const base: RemoteWorkbenchCredentialResolution = {
  request: { command: 'test', env: { API_TOKEN: 'secret-sentinel', TOWER_REMOTE_GWS_CONFIG_B64: 'envelope-sentinel' } },
  environmentKeys: ['API_TOKEN'], injected: [], materializedFiles: [], skipped: [], suppressed: false,
};
it('preserves suppression without claiming missing credentials or provider failure', () => {
  const result = workbenchCredentialDiagnostics({ ...base, suppressed: true, suppressReason: 'external package install' });
  expect(result).toMatchObject({ stage: 'selection', suppressed: true, suppress_reason: 'external package install', provider_verification: 'not-performed-by-selection' });
  expect(JSON.stringify(result)).not.toContain('sentinel');
  expect(result).not.toHaveProperty('request');
});
it('distinguishes selection from file materialization and carries skip reasons', () => {
  const result = workbenchCredentialDiagnostics({ ...base, injected: [{ credentialId: 'api', envName: 'API_TOKEN' }], materializedFiles: [{ credentialId: 'ssh', envName: 'SSH_KEY_FILE' }], skipped: [{ credentialId: 'other', reason: 'not requested' }] });
  expect(result.selected_files).toEqual([{ credential_id: 'ssh', env_name: 'SSH_KEY_FILE' }]);
  expect(result.skipped[0].reason).toBe('not requested');
  expect(result).not.toHaveProperty('materialized');
  expect(JSON.stringify(result)).not.toContain('sentinel');
});

it('reports bundle selection metadata without any bundle value or authentication claim', () => {
  const result = workbenchCredentialDiagnostics({ ...base, selectedBundles: [{ credentialId: 'gws-work', provider: 'google' }, { credentialId: 'higgsfield-cli-oauth', provider: 'higgsfield' }] });
  expect(result.selected_bundles).toEqual([{ credential_id: 'gws-work', provider: 'google' }, { credential_id: 'higgsfield-cli-oauth', provider: 'higgsfield' }]);
  expect(JSON.stringify(result)).not.toContain('sentinel');
  expect(result.provider_verification).toBe('not-performed-by-selection');
});

it('reports safe per-env selection reasons without serializing the request', () => {
  const result = workbenchCredentialDiagnostics({ ...base, unresolvedReasons: [{ envName: 'API_TOKEN', reason: 'LegacyPersonalCredentialBlocked' }] });
  expect(result.unresolved_reasons).toEqual([{ env_name: 'API_TOKEN', reason: 'LegacyPersonalCredentialBlocked' }]);
  expect(JSON.stringify(result)).not.toContain('sentinel');
});
