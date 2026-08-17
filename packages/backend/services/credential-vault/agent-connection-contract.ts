/**
 * Owns: the stable, secret-free Connection contract used by agents and UI preflight.
 * Provider/env/materialization details stay behind this module.
 */
import type { ConnectionReadiness } from './connection-read-model.js';

export type ConnectionReasonCode =
  | 'Ready'
  | 'MissingConfiguration'
  | 'ProjectAccessRequired'
  | 'MaterializationFailed'
  | 'InvalidCredential'
  | 'ReauthRequired'
  | 'ProviderUnavailable'
  | 'ProbeUnsupported'
  | 'ConnectionDisabled';

export type ConnectionRecommendedAction = 'none' | 'connect' | 'test' | 'rotate' | 'reauth' | 'inspect' | 'contact_admin';

export interface AgentConnectionRecord {
  connectionId: string;
  displayName: string;
  provider: string;
  capabilities: readonly string[];
  readiness: ConnectionReadiness;
  configurationStatus?: 'complete' | 'incomplete' | 'disabled';
  safeSummary?: string | null;
}

export interface AgentConnectionView {
  connectionId: string;
  displayName: string;
  provider: string;
  capabilities: readonly string[];
  effectiveStatus: ConnectionReadiness['effectiveStatus'];
  canUseNow: boolean;
  reasonCode: ConnectionReasonCode;
  recommendedAction: {
    type: ConnectionRecommendedAction;
    requiresUserInteraction: boolean;
    requiresAdminApproval: boolean;
  };
  safeSummary: string;
}

export interface CapabilityResolution {
  capability: string;
  ready: boolean;
  selected: AgentConnectionView | null;
  alternatives: AgentConnectionView[];
  reasonCode: ConnectionReasonCode;
}

function reasonFor(record: AgentConnectionRecord): ConnectionReasonCode {
  if (record.configurationStatus === 'incomplete') return 'MissingConfiguration';
  if (record.configurationStatus === 'disabled' || record.readiness.effectiveStatus === 'disabled') return 'ConnectionDisabled';
  if (record.readiness.effectiveStatus === 'off') return 'ProjectAccessRequired';
  if (record.readiness.materialization.status === 'failed') return 'MaterializationFailed';
  switch (record.readiness.providerHealth.status) {
    case 'ready': return 'Ready';
    case 'invalid': return 'InvalidCredential';
    case 'reauth_required': return 'ReauthRequired';
    case 'degraded': return 'ProviderUnavailable';
    case 'unsupported': return 'ProbeUnsupported';
    default: return 'ProbeUnsupported';
  }
}

function actionFor(reasonCode: ConnectionReasonCode): AgentConnectionView['recommendedAction'] {
  switch (reasonCode) {
    case 'Ready': return { type: 'none', requiresUserInteraction: false, requiresAdminApproval: false };
    case 'ProjectAccessRequired': return { type: 'connect', requiresUserInteraction: false, requiresAdminApproval: true };
    case 'InvalidCredential': return { type: 'rotate', requiresUserInteraction: true, requiresAdminApproval: true };
    case 'ReauthRequired': return { type: 'reauth', requiresUserInteraction: true, requiresAdminApproval: false };
    case 'ProbeUnsupported': return { type: 'test', requiresUserInteraction: false, requiresAdminApproval: false };
    case 'ConnectionDisabled': return { type: 'contact_admin', requiresUserInteraction: false, requiresAdminApproval: true };
    default: return { type: 'inspect', requiresUserInteraction: false, requiresAdminApproval: false };
  }
}

function summaryFor(record: AgentConnectionRecord, reasonCode: ConnectionReasonCode): string {
  if (record.safeSummary) return record.safeSummary;
  switch (reasonCode) {
    case 'Ready': return `${record.displayName} 연결을 현재 사용할 수 있습니다.`;
    case 'MissingConfiguration': return `${record.displayName} 연결 설정이 완료되지 않았습니다.`;
    case 'ProjectAccessRequired': return `${record.displayName} 연결을 이 프로젝트에서 사용하려면 승인이 필요합니다.`;
    case 'MaterializationFailed': return `${record.displayName} 연결을 실행 환경에 준비하지 못했습니다.`;
    case 'InvalidCredential': return `${record.displayName} 인증정보를 교체해야 합니다.`;
    case 'ReauthRequired': return `${record.displayName} 로그인이 만료되어 다시 연결해야 합니다.`;
    case 'ProviderUnavailable': return `${record.displayName} 서비스 상태를 확인해야 합니다.`;
    case 'ConnectionDisabled': return `${record.displayName} 연결이 관리자에 의해 꺼져 있습니다.`;
    default: return `${record.displayName} 연결은 구성됐지만 실제 사용 가능 여부가 확인되지 않았습니다.`;
  }
}

/** Return only stable metadata and decisions; never underlying env names or credentials. */
export function diagnoseConnection(record: AgentConnectionRecord): AgentConnectionView {
  const reasonCode = reasonFor(record);
  return {
    connectionId: record.connectionId,
    displayName: record.displayName,
    provider: record.provider,
    capabilities: [...record.capabilities],
    effectiveStatus: record.readiness.effectiveStatus,
    canUseNow: record.readiness.effectiveStatus === 'ready' && reasonCode === 'Ready',
    reasonCode,
    recommendedAction: actionFor(reasonCode),
    safeSummary: summaryFor(record, reasonCode),
  };
}

/** Prefer a ready Connection; otherwise return the best actionable candidate without guessing credentials. */
export function resolveCapability(records: readonly AgentConnectionRecord[], capability: string): CapabilityResolution {
  const candidates = records
    .filter(record => record.capabilities.includes(capability))
    .map(diagnoseConnection)
    .sort((a, b) => Number(b.canUseNow) - Number(a.canUseNow));
  const selected = candidates[0] ?? null;
  return {
    capability,
    ready: selected?.canUseNow ?? false,
    selected,
    alternatives: candidates.slice(1),
    reasonCode: selected?.reasonCode ?? 'MissingConfiguration',
  };
}

/** Hard preflight: callers must not invoke the Provider when ready is false. */
export function requireReady(records: readonly AgentConnectionRecord[], capability: string): CapabilityResolution {
  return resolveCapability(records, capability);
}
