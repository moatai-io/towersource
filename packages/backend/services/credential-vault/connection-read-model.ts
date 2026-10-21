/**
 * Owns: additive Connection readiness labels derived from existing grant state.
 * Public API: deriveConnectionReadiness. Provider probes can replace `unknown` later.
 */

export type ConnectionEffectiveStatus = 'ready' | 'needs_attention' | 'connected_unverified' | 'off' | 'disabled';
export type ProviderHealthStatus = 'ready' | 'invalid' | 'reauth_required' | 'degraded' | 'unknown' | 'unsupported';

export interface ConnectionReadinessInput {
  enabled: boolean;
  existingStatus: 'connected' | 'needs_attention' | 'disabled' | 'off';
  connectedProjectCount: number;
  blockedProjectCount: number;
  attentionProjectCount: number;
  lastMaterializedAt?: string | null;
  materializationFailed?: boolean;
  providerHealth?: {
    status: ProviderHealthStatus;
    checkedAt?: string | null;
    reasonCode?: string | null;
  } | null;
}

export interface ConnectionReadiness {
  access: {
    status: 'connected' | 'off' | 'blocked' | 'mixed';
    connectedProjectCount: number;
    blockedProjectCount: number;
  };
  materialization: {
    status: 'verified' | 'failed' | 'unknown';
    lastCheckedAt: string | null;
  };
  providerHealth: {
    status: ProviderHealthStatus;
    checkedAt: string | null;
    reasonCode: string | null;
    action: 'none' | 'test' | 'rotate' | 'reauth' | 'inspect';
  };
  effectiveStatus: ConnectionEffectiveStatus;
}

/** Distinguish project access/materialization from actual Provider readiness. */
export function deriveConnectionReadiness(input: ConnectionReadinessInput): ConnectionReadiness {
  const providerHealth = input.providerHealth ?? { status: 'unknown' as const, checkedAt: null, reasonCode: null };
  const accessStatus = input.connectedProjectCount > 0 && input.blockedProjectCount > 0
    ? 'mixed'
    : input.connectedProjectCount > 0
      ? 'connected'
      : input.blockedProjectCount > 0
        ? 'blocked'
        : 'off';

  let effectiveStatus: ConnectionEffectiveStatus;
  if (!input.enabled || input.existingStatus === 'disabled') effectiveStatus = 'disabled';
  else if (input.existingStatus === 'needs_attention' || input.attentionProjectCount > 0) effectiveStatus = 'needs_attention';
  else if (input.connectedProjectCount === 0) effectiveStatus = 'off';
  else if (input.materializationFailed) effectiveStatus = 'needs_attention';
  else if (providerHealth.status === 'ready' && input.lastMaterializedAt) effectiveStatus = 'ready';
  else if (['invalid', 'reauth_required', 'degraded'].includes(providerHealth.status)) effectiveStatus = 'needs_attention';
  else effectiveStatus = 'connected_unverified';

  const action = providerHealth.status === 'invalid' ? 'rotate'
    : providerHealth.status === 'reauth_required' ? 'reauth'
      : providerHealth.status === 'ready' ? 'none'
        : providerHealth.status === 'degraded' ? 'inspect'
          : 'test';

  return {
    access: {
      status: accessStatus,
      connectedProjectCount: input.connectedProjectCount,
      blockedProjectCount: input.blockedProjectCount,
    },
    materialization: {
      status: input.materializationFailed ? 'failed' : input.lastMaterializedAt ? 'verified' : 'unknown',
      lastCheckedAt: input.lastMaterializedAt ?? null,
    },
    providerHealth: {
      status: providerHealth.status,
      checkedAt: providerHealth.checkedAt ?? null,
      reasonCode: providerHealth.reasonCode ?? null,
      action,
    },
    effectiveStatus,
  };
}
