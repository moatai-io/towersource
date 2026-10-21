import type { RemoteWorkbenchCredentialResolution } from './workbench-remote-credential-resolution.js';

/** Selection evidence only. Never serialize the resolver request/env/envelope or claim provider auth. */
export function workbenchCredentialDiagnostics(resolution: RemoteWorkbenchCredentialResolution) {
  return {
    stage: 'selection' as const,
    scope: 'worker-credential-selection' as const,
    declared_requirements: resolution.declaredRequirements ?? [],
    unresolved_env_names: resolution.unsatisfiedRequirements ?? [],
    unresolved_reasons: (resolution.unresolvedReasons ?? []).map(item => ({ env_name: item.envName, reason: item.reason })),
    unresolved_meaning: 'No matching output env/file-path name; aliases may differ. Not proof of missing Vault storage.' as const,
    suppressed: resolution.suppressed,
    ...(resolution.suppressReason ? { suppress_reason: resolution.suppressReason } : {}),
    selected_bundles: (resolution.selectedBundles ?? []).map(item => ({ credential_id: item.credentialId, provider: item.provider })),
    selected_env: resolution.injected.map(item => ({ credential_id: item.credentialId, env_name: item.envName })),
    selected_files: resolution.materializedFiles.map(item => ({ credential_id: item.credentialId, env_name: item.envName })),
    skipped: resolution.skipped.map(item => ({ credential_id: item.credentialId, env_name: item.envName, reason: item.reason })),
    provider_verification: 'not-performed-by-selection' as const,
  };
}
