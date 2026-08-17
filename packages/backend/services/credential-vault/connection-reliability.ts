import { query, queryOne } from '../../db/pg-repo.js';
import { resolveProjectCredentialSecretValue, resolveRuntimeBoxApiKeyEnv } from './credential-vault-service.js';

export type ConnectionStage = 'inventory' | 'project_access' | 'materialization' | 'provider_health' | 'agent_surface' | 'provider_auth' | 'fleet_drift';
export type ConnectionDiagnosticStatus = 'ready' | 'needs_attention' | 'unverified' | 'missing';

export interface ConnectionReliabilityDiagnostic {
  connectionId: string;
  displayName: string;
  capability: string;
  status: ConnectionDiagnosticStatus;
  stoppedAt: ConnectionStage | null;
  reasonCode: 'Ready' | 'MissingConnection' | 'ProjectAccessRequired' | 'MaterializationFailed' | 'ProviderAuthUnverified' | 'InvalidCredential' | 'FleetDrift';
  summary: string;
  nextAction: 'none' | 'connect' | 'reauth' | 'test' | 'inspect' | 'contact_admin';
  stages: Array<{ stage: ConnectionStage; status: 'pass' | 'fail' | 'unknown'; summary: string }>;
}

export interface ProjectConnectionDiagnostics {
  inventoryComplete: true;
  coverage: 'known-and-agent-bound';
  connections: ConnectionReliabilityDiagnostic[];
}

const KNOWN_CONNECTIONS = [
  { id: 'agent-store-default', name: 'Agent Store', capability: 'agent_store', kind: 'api_key', provider: 'agent-store' },
] as const;

function safeStage(stage: ConnectionStage, status: 'pass' | 'fail' | 'unknown', summary: string) {
  return { stage, status, summary };
}

async function diagnoseKnownConnection(input: { projectId: string; userId: number; spec: typeof KNOWN_CONNECTIONS[number] }): Promise<ConnectionReliabilityDiagnostic> {
  const row = await queryOne<{ id: string; enabled: boolean }>('SELECT id, enabled FROM workspace_credentials WHERE id = $1', [input.spec.id]);
  if (!row?.enabled) return {
    connectionId: input.spec.id, displayName: input.spec.name, capability: input.spec.capability,
    status: 'missing', stoppedAt: 'inventory', reasonCode: 'MissingConnection', summary: `${input.spec.name} Connection이 이 Tower에 준비되지 않았습니다.`, nextAction: 'contact_admin',
    stages: [safeStage('inventory', 'fail', 'Connection metadata가 없거나 사용 중지 상태입니다.')],
  };
  const resolved = await resolveProjectCredentialSecretValue({
    projectId: input.projectId, userId: input.userId, credentialId: input.spec.id,
    kind: input.spec.kind, provider: input.spec.provider, targetType: 'agent_connection_diagnostic',
  });
  if (!resolved) return {
    connectionId: input.spec.id, displayName: input.spec.name, capability: input.spec.capability,
    status: 'needs_attention', stoppedAt: 'project_access', reasonCode: 'ProjectAccessRequired', summary: `${input.spec.name}은 저장돼 있지만 이 프로젝트에서 사용할 수 없습니다.`, nextAction: 'connect',
    stages: [safeStage('inventory', 'pass', 'Connection metadata가 활성 상태입니다.'), safeStage('project_access', 'fail', '프로젝트 기본 연결 또는 명시 허용이 없습니다.')],
  };
  return {
    connectionId: input.spec.id, displayName: input.spec.name, capability: input.spec.capability,
    status: 'unverified', stoppedAt: 'provider_health', reasonCode: 'ProviderAuthUnverified', summary: `${input.spec.name}은 이 프로젝트에 연결됐습니다. 실제 Provider 인증은 사용 전에 확인해야 합니다.`, nextAction: 'test',
    stages: [
      safeStage('inventory', 'pass', 'Connection metadata가 활성 상태입니다.'),
      safeStage('project_access', 'pass', '현재 사용자와 프로젝트에서 사용할 수 있습니다.'),
      safeStage('materialization', 'pass', 'Vault 값을 실행 경로에서 해석할 수 있습니다.'),
      safeStage('provider_health', 'unknown', 'Provider 인증 근거가 아직 없습니다.'),
    ],
  };
}

async function diagnoseHiggsfield(input: { projectId: string; userId: number }): Promise<ConnectionReliabilityDiagnostic> {
  const rows = await query<{
    id: string;
    display_name: string;
    enabled: boolean;
    default_env_name: string | null;
  }>(
    `SELECT c.id, c.display_name, c.enabled, COALESCE(p.target_env_name, c.default_env_name) AS default_env_name
       FROM workspace_credentials c
       LEFT JOIN project_credential_policies p ON p.credential_id = c.id AND p.project_id = $1
      WHERE c.provider = 'higgsfield'
        AND c.kind = 'api_key'
        AND c.enabled = true
        AND COALESCE(p.mode, '') <> 'deny'
        AND COALESCE(p.target_env_name, c.default_env_name) = ANY($2::text[])
      ORDER BY c.id`,
    [input.projectId, ['HIGGSFIELD_API_KEY_ID', 'HIGGSFIELD_API_KEY_SECRET']],
  );
  const configuredTargets = new Set(rows.map(row => row.default_env_name));
  const inventoryComplete = configuredTargets.has('HIGGSFIELD_API_KEY_ID') && configuredTargets.has('HIGGSFIELD_API_KEY_SECRET');
  if (!inventoryComplete) return {
    connectionId: 'higgsfield-cloud-api', displayName: 'Higgsfield', capability: 'video_generation', status: 'missing', stoppedAt: 'inventory', reasonCode: 'MissingConnection',
    summary: 'Higgsfield Cloud API 구성에 필요한 Credential 묶음이 완전하지 않습니다.', nextAction: 'contact_admin',
    stages: [safeStage('inventory', 'fail', 'Cloud API ID와 Secret 중 하나 이상이 없습니다.')],
  };
  const env = await resolveRuntimeBoxApiKeyEnv({ projectId: input.projectId, userId: input.userId });
  const injectedTargets = new Set(env.injected.map(item => item.envName));
  const complete = injectedTargets.has('HIGGSFIELD_API_KEY_ID') && injectedTargets.has('HIGGSFIELD_API_KEY_SECRET');
  if (!complete) return {
    connectionId: 'higgsfield-cloud-api', displayName: 'Higgsfield', capability: 'video_generation', status: 'needs_attention', stoppedAt: 'project_access', reasonCode: 'ProjectAccessRequired',
    summary: 'Higgsfield Credential은 저장돼 있지만 이 프로젝트에서 완전한 묶음으로 사용할 수 없습니다.', nextAction: 'connect',
    stages: [safeStage('inventory', 'pass', 'Cloud API Credential 묶음이 저장돼 있습니다.'), safeStage('project_access', 'fail', '프로젝트에서 ID와 Secret 전체를 사용할 수 없습니다.')],
  };
  return {
    connectionId: 'higgsfield-cloud-api', displayName: 'Higgsfield', capability: 'video_generation', status: 'unverified', stoppedAt: 'provider_auth', reasonCode: 'ProviderAuthUnverified',
    summary: 'Higgsfield Cloud API Credential 묶음은 Runtime에 전달 가능합니다. 이전 401 또는 Provider 인증 실패가 있었다면 자동 재시도하지 말고 Credential 교체 또는 재로그인을 진행해야 합니다.', nextAction: 'test',
    stages: [safeStage('inventory', 'pass', 'Cloud API Credential 묶음이 저장돼 있습니다.'), safeStage('project_access', 'pass', '프로젝트에서 전체 묶음을 사용할 수 있습니다.'), safeStage('materialization', 'pass', 'Runtime 주입 계획이 완전합니다.'), safeStage('provider_health', 'unknown', 'Cloud API의 무과금 auth-only probe가 없습니다.')],
  };
}

async function diagnoseAllowedGwsConnections(input: { projectId: string; userId: number }): Promise<ConnectionReliabilityDiagnostic[]> {
  const rows = await query<{ id: string; display_name: string; mode: string }>(
    `SELECT c.id, c.display_name, p.mode
       FROM workspace_credentials c
       JOIN project_credential_policies p
         ON p.credential_id = c.id AND p.project_id = $1
      WHERE c.enabled = true
        AND c.kind = 'gws'
        AND c.provider = 'google'
        AND p.mode IN ('allow', 'override', 'inherit')
      ORDER BY lower(c.display_name), c.id`,
    [input.projectId],
  );
  return Promise.all(rows.map(async row => {
    const resolved = await resolveProjectCredentialSecretValue({
      projectId: input.projectId,
      userId: input.userId,
      credentialId: row.id,
      kind: 'gws',
      provider: 'google',
      targetType: 'agent_connection_diagnostic',
    });
    if (!resolved) return {
      connectionId: row.id,
      displayName: row.display_name,
      capability: 'google_workspace',
      status: 'needs_attention',
      stoppedAt: 'materialization',
      reasonCode: 'MaterializationFailed',
      summary: `${row.display_name}은 Agent에 허용돼 있지만 Runtime에서 해석할 수 없습니다. 재로그인보다 먼저 Connection 구성을 점검해야 합니다.`,
      nextAction: 'inspect',
      stages: [
        safeStage('inventory', 'pass', 'Google Workspace Connection이 저장돼 있습니다.'),
        safeStage('project_access', 'pass', '현재 Agent에서 사용할 수 있습니다.'),
        safeStage('materialization', 'fail', 'Runtime에서 선택한 Credential을 해석하지 못했습니다.'),
      ],
    } satisfies ConnectionReliabilityDiagnostic;
    return {
      connectionId: row.id,
      displayName: row.display_name,
      capability: 'google_workspace',
      status: 'unverified',
      stoppedAt: 'provider_health',
      reasonCode: 'ProviderAuthUnverified',
      summary: `${row.display_name}은 이 Agent가 선택해 사용할 수 있습니다. 실제 Google 계정과 토큰 상태는 최소 read-only 호출로 확인해야 합니다.`,
      nextAction: 'test',
      stages: [
        safeStage('inventory', 'pass', 'Google Workspace Connection이 저장돼 있습니다.'),
        safeStage('project_access', 'pass', '현재 Agent에서 사용할 수 있습니다.'),
        safeStage('materialization', 'pass', '선택 시 Runtime에 단독 주입할 수 있습니다.'),
        safeStage('provider_health', 'unknown', '실제 Google 계정과 토큰 상태를 아직 확인하지 않았습니다.'),
      ],
    } satisfies ConnectionReliabilityDiagnostic;
  }));
}

async function diagnoseAgentBoundCredentials(input: { projectId: string; userId: number }): Promise<ConnectionReliabilityDiagnostic[]> {
  const rows = await query<{
    id: string;
    provider: string;
    display_name: string;
    metadata: Record<string, unknown> | null;
    mode: string;
  }>(
    `SELECT c.id, c.provider, c.display_name, c.metadata, p.mode
       FROM workspace_credentials c
       JOIN project_credential_policies p
         ON p.credential_id = c.id AND p.project_id = $1
      WHERE (c.scope = 'project' OR c.scope = 'personal')
        AND c.kind = 'api_key'
        AND c.enabled = true
        AND c.metadata->>'connection_type' = 'agent'
        AND c.metadata->>'agent_project_id' = $1
      ORDER BY c.provider, c.display_name, c.id`,
    [input.projectId],
  );
  if (rows.length === 0) return [];

  const runtime = await resolveRuntimeBoxApiKeyEnv({ projectId: input.projectId, userId: input.userId });
  const materializedIds = new Set(runtime.injected.map(item => item.credentialId));
  const skippedById = new Map(runtime.skipped.map(item => [item.credentialId, item.reason]));

  return rows.map(row => {
    const capability = typeof row.metadata?.capability === 'string' && row.metadata.capability.trim()
      ? row.metadata.capability.trim()
      : row.provider;
    const accessAllowed = ['allow', 'override', 'inherit'].includes(row.mode);
    if (!accessAllowed) return {
      connectionId: row.id,
      displayName: row.display_name,
      capability,
      status: 'needs_attention',
      stoppedAt: 'project_access',
      reasonCode: 'ProjectAccessRequired',
      summary: `${row.display_name} Credential은 저장돼 있지만 현재 Agent에서 사용할 수 없습니다.`,
      nextAction: 'connect',
      stages: [
        safeStage('inventory', 'pass', 'Agent 전용 Credential이 Vault에 저장돼 있습니다.'),
        safeStage('project_access', 'fail', '현재 Agent binding이 실행을 허용하지 않습니다.'),
      ],
    } satisfies ConnectionReliabilityDiagnostic;

    if (!materializedIds.has(row.id)) return {
      connectionId: row.id,
      displayName: row.display_name,
      capability,
      status: 'needs_attention',
      stoppedAt: 'materialization',
      reasonCode: 'MaterializationFailed',
      summary: `${row.display_name} Credential은 저장되고 연결됐지만 Runtime 주입 계획에서 확인되지 않았습니다. 일시적 materialization 오류일 수 있으므로 재입력하지 말고 연결 설정을 점검해야 합니다.`,
      nextAction: 'inspect',
      stages: [
        safeStage('inventory', 'pass', 'Agent 전용 Credential이 Vault에 저장돼 있습니다.'),
        safeStage('project_access', 'pass', '현재 Agent binding이 실행을 허용합니다.'),
        safeStage('materialization', 'fail', skippedById.has(row.id) ? 'Credential 종류별 materialization 경로를 추가 확인해야 합니다.' : 'Runtime 환경 주입 계획에서 Credential을 찾지 못했습니다.'),
      ],
    } satisfies ConnectionReliabilityDiagnostic;

    return {
      connectionId: row.id,
      displayName: row.display_name,
      capability,
      status: 'unverified',
      stoppedAt: 'provider_health',
      reasonCode: 'ProviderAuthUnverified',
      summary: `${row.display_name} Credential은 저장·Agent 연결·Runtime 주입까지 확인됐습니다. Provider 인증은 아직 확인하지 않았습니다.`,
      nextAction: 'test',
      stages: [
        safeStage('inventory', 'pass', 'Agent 전용 Credential이 Vault에 저장돼 있습니다.'),
        safeStage('project_access', 'pass', '현재 Agent binding이 실행을 허용합니다.'),
        safeStage('materialization', 'pass', 'Runtime 주입 계획에서 Credential을 확인했습니다.'),
        safeStage('provider_health', 'unknown', 'Provider의 읽기 전용 인증 근거가 아직 없습니다.'),
      ],
    } satisfies ConnectionReliabilityDiagnostic;
  });
}

export async function diagnoseProjectConnections(input: { projectId: string; userId: number; providerEvidence?: { higgsfieldInvalidCredential?: boolean } }): Promise<ConnectionReliabilityDiagnostic[]> {
  const known = await Promise.all(KNOWN_CONNECTIONS.map(spec => diagnoseKnownConnection({ ...input, spec })));
  const higgsfield = await diagnoseHiggsfield(input);
  if (input.providerEvidence?.higgsfieldInvalidCredential && higgsfield.status === 'unverified') {
    higgsfield.status = 'needs_attention';
    higgsfield.stoppedAt = 'provider_auth';
    higgsfield.reasonCode = 'InvalidCredential';
    higgsfield.nextAction = 'reauth';
    higgsfield.summary = 'Higgsfield Credential은 Runtime까지 전달됐지만 Provider가 인증을 거부했습니다. 같은 생성 요청을 자동 재시도하지 말고 Credential 교체 또는 재로그인을 진행해야 합니다.';
    higgsfield.stages = [...higgsfield.stages, safeStage('provider_auth', 'fail', 'Provider가 인증을 거부했습니다.')];
  }
  const [gws, agentBound] = await Promise.all([
    diagnoseAllowedGwsConnections(input),
    diagnoseAgentBoundCredentials(input),
  ]);
  const fixedIds = new Set([...known, higgsfield, ...gws].map(item => item.connectionId));
  return [...known, higgsfield, ...gws, ...agentBound.filter(item => !fixedIds.has(item.connectionId))];
}

export async function diagnoseProjectConnectionStatus(input: { projectId: string; userId: number; providerEvidence?: { higgsfieldInvalidCredential?: boolean } }): Promise<ProjectConnectionDiagnostics> {
  return {
    inventoryComplete: true,
    coverage: 'known-and-agent-bound',
    connections: await diagnoseProjectConnections(input),
  };
}
