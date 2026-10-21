import { query } from '../../db/pg-repo.js';
import {
  resolveProjectCredentialSecretValue,
  resolveRuntimeBoxApiKeyEnv,
  resolveRuntimeBoxCredentialFileMaterialization,
} from './credential-vault-service.js';

export type ConnectionStage = 'inventory' | 'project_access' | 'materialization' | 'provider_health' | 'provider_auth';
export type ConnectionDiagnosticStatus = 'ready' | 'needs_attention' | 'unverified' | 'missing';
export interface ConnectionReliabilityDiagnostic {
  connectionId: string;
  displayName: string;
  capability: string;
  status: ConnectionDiagnosticStatus;
  stoppedAt: ConnectionStage | null;
  reasonCode: 'Ready' | 'MissingConnection' | 'MaterializationFailed' | 'ProviderAuthUnverified' | 'InvalidCredential';
  summary: string;
  nextAction: 'none' | 'reauth' | 'test' | 'inspect' | 'contact_admin';
  stages: Array<{ stage: ConnectionStage; status: 'pass' | 'fail' | 'unknown'; summary: string }>;
}
export interface ProjectConnectionDiagnostics {
  inventoryComplete: true;
  coverage: 'team-shared-and-agent-dedicated';
  connections: ConnectionReliabilityDiagnostic[];
}

function stage(stageName: ConnectionStage, status: 'pass' | 'fail' | 'unknown', summary: string) {
  return { stage: stageName, status, summary };
}

/** Diagnose the complete effective inventory: all workspace rows plus project rows owned by this Agent. */
export async function diagnoseProjectConnections(input: { projectId: string; userId: number; providerEvidence?: { higgsfieldInvalidCredential?: boolean } }): Promise<ConnectionReliabilityDiagnostic[]> {
  const rows = await query<{ id: string; provider: string; kind: string; display_name: string; metadata: Record<string, unknown>; scope: 'workspace' | 'project' }>(
    `SELECT c.id, c.provider, c.kind, c.display_name, c.metadata, c.scope
       FROM workspace_credentials c
      WHERE c.enabled = true
        AND (c.scope = 'workspace' OR (c.scope = 'project' AND c.project_id = $1))
      ORDER BY CASE c.scope WHEN 'workspace' THEN 0 ELSE 1 END, c.provider, c.display_name, c.id`,
    [input.projectId],
  );
  const runtime = await resolveRuntimeBoxApiKeyEnv({ projectId: input.projectId, userId: input.userId });
  const fileRuntime = await resolveRuntimeBoxCredentialFileMaterialization({ projectId: input.projectId, userId: input.userId });
  const materializedIds = new Set([
    ...runtime.injected.map(item => item.credentialId),
    ...fileRuntime.materialize.map(item => item.credentialId),
  ]);
  const skippedById = new Map([...runtime.skipped, ...fileRuntime.skipped].map(item => [item.credentialId, item.reason]));

  return Promise.all(rows.map(async row => {
    const capability = typeof row.metadata?.capability === 'string' && row.metadata.capability.trim() ? row.metadata.capability.trim() : row.provider;
    const skippedReason = skippedById.get(row.id);
    const shadowed = skippedReason?.startsWith('duplicate target env;') === true;
    let materialized = materializedIds.has(row.id) || shadowed;
    if (row.kind !== 'api_key') {
      try {
        materialized = Boolean(await resolveProjectCredentialSecretValue({ projectId: input.projectId, userId: input.userId, credentialId: row.id, kind: row.kind, provider: row.provider, targetType: 'agent_connection_diagnostic' }));
      } catch {
        // One denied legacy connection must not abort the entire inventory.
        // Never return raw exception text: providers may include credential data.
        materialized = false;
      }
    }
    if (!materialized) return {
      connectionId: row.id, displayName: row.display_name, capability,
      status: 'needs_attention', stoppedAt: 'materialization', reasonCode: 'MaterializationFailed',
      summary: `${row.display_name} Credential은 목록에 있지만 Runtime에서 해석되지 않았습니다. 재입력 전에 저장·주입 상태를 점검해야 합니다.`, nextAction: 'inspect',
      stages: [stage('inventory', 'pass', row.scope === 'workspace' ? '팀 공용 Credential이 활성 상태입니다.' : '현재 Agent 전용 Credential이 활성 상태입니다.'), stage('project_access', 'pass', row.scope === 'workspace' ? '모든 일반 Project에 자동 사용됩니다.' : 'Credential의 project_id가 현재 Agent와 일치합니다.'), stage('materialization', 'fail', skippedById.get(row.id) ?? 'Runtime materialization 결과에서 Credential을 찾지 못했습니다.')],
    } satisfies ConnectionReliabilityDiagnostic;

    const invalidHiggsfield = row.provider === 'higgsfield' && input.providerEvidence?.higgsfieldInvalidCredential;
    return {
      connectionId: row.id, displayName: row.display_name, capability,
      status: invalidHiggsfield ? 'needs_attention' : 'unverified',
      stoppedAt: invalidHiggsfield ? 'provider_auth' : 'provider_health',
      reasonCode: invalidHiggsfield ? 'InvalidCredential' : 'ProviderAuthUnverified',
      summary: invalidHiggsfield ? `${row.display_name} Credential은 Runtime에 전달됐지만 Provider가 인증을 거부했습니다.` : `${row.display_name} Credential은 저장·접근·Runtime 주입 계획까지 확인됐습니다. 실제 프로세스 주입과 Provider 인증은 아직 확인하지 않았습니다.`,
      nextAction: invalidHiggsfield ? 'reauth' : 'test',
      stages: [stage('inventory', 'pass', row.scope === 'workspace' ? '팀 공용 Credential이 활성 상태입니다.' : '현재 Agent 전용 Credential이 활성 상태입니다.'), stage('project_access', 'pass', row.scope === 'workspace' ? '모든 일반 Project에 자동 사용됩니다.' : 'Credential의 project_id가 현재 Agent와 일치합니다.'), stage('materialization', 'pass', shadowed ? '같은 대상의 Agent 전용 Credential이 우선 선택되어 이 Credential은 안전하게 대기합니다.' : 'Runtime 주입 계획에서 Credential을 확인했습니다.'), stage(invalidHiggsfield ? 'provider_auth' : 'provider_health', invalidHiggsfield ? 'fail' : 'unknown', invalidHiggsfield ? 'Provider가 인증을 거부했습니다.' : 'Provider 인증 근거가 아직 없습니다.')],
    } satisfies ConnectionReliabilityDiagnostic;
  }));
}

export async function diagnoseProjectConnectionStatus(input: { projectId: string; userId: number; providerEvidence?: { higgsfieldInvalidCredential?: boolean } }): Promise<ProjectConnectionDiagnostics> {
  return { inventoryComplete: true, coverage: 'team-shared-and-agent-dedicated', connections: await diagnoseProjectConnections(input) };
}
