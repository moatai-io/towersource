/**
 * Owns: Higgsfield-specific health probe policy and redacted result classification.
 * Does not execute the CLI or accept raw credentials.
 */
import type { ProviderHealthStatus } from '../connection-read-model.js';

export type HiggsfieldAuthMethod = 'cloud_api' | 'cli_oauth';

export interface HiggsfieldProbePolicy {
  supported: boolean;
  command: readonly string[] | null;
  reasonCode: 'SafeReadOnlyCliStatus' | 'NoDocumentedSafeProbe';
  storesProviderBody: false;
}

export interface HiggsfieldProbeObservation {
  exitCode: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

export interface HiggsfieldProbeClassification {
  status: ProviderHealthStatus;
  reasonCode: 'Ready' | 'ReauthRequired' | 'ProviderUnavailable' | 'ProbeUnsupported';
}

/** Cloud API docs expose generation calls but no documented no-charge auth-only endpoint. */
export function higgsfieldProbePolicy(authMethod: HiggsfieldAuthMethod): HiggsfieldProbePolicy {
  if (authMethod === 'cli_oauth') {
    return {
      supported: true,
      command: ['higgsfield', 'account', 'status', '--json', '--no-color'],
      reasonCode: 'SafeReadOnlyCliStatus',
      storesProviderBody: false,
    };
  }
  return {
    supported: false,
    command: null,
    reasonCode: 'NoDocumentedSafeProbe',
    storesProviderBody: false,
  };
}

/** Classify locally and discard stdout/stderr; callers must persist only the returned codes. */
export function classifyHiggsfieldCliStatus(observation: HiggsfieldProbeObservation): HiggsfieldProbeClassification {
  if (observation.timedOut) return { status: 'degraded', reasonCode: 'ProviderUnavailable' };
  const diagnostic = `${observation.stdout ?? ''}\n${observation.stderr ?? ''}`.toLowerCase();
  if (diagnostic.includes('not authenticated') || diagnostic.includes('session expired') || diagnostic.includes('unauthorized')) {
    return { status: 'reauth_required', reasonCode: 'ReauthRequired' };
  }
  if (observation.exitCode === 0) return { status: 'ready', reasonCode: 'Ready' };
  return { status: 'degraded', reasonCode: 'ProviderUnavailable' };
}
