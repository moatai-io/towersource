import { createHash, randomUUID } from 'node:crypto';

export type ConnectionAssistantAction = 'connect' | 'disconnect';
export type ConnectionSource = 'credential' | 'profile';

export interface ConnectionManifest {
  provider: string;
  displayName: string;
  capabilities: string[];
  authMethods: Array<{ id: string; label: string; probe: 'safe' | 'unsupported' }>;
}

const MANIFESTS: ConnectionManifest[] = [
  {
    provider: 'higgsfield',
    displayName: 'Higgsfield',
    capabilities: ['video_generation'],
    authMethods: [
      { id: 'cli_oauth', label: 'Higgsfield 계정 로그인', probe: 'safe' },
      { id: 'cloud_api', label: 'Higgsfield Cloud API', probe: 'unsupported' },
    ],
  },
];

export function connectionManifest(provider: string | null | undefined): ConnectionManifest {
  const normalized = String(provider || 'custom').toLowerCase();
  return MANIFESTS.find(item => item.provider === normalized) ?? {
    provider: normalized,
    displayName: provider || '외부 서비스',
    capabilities: [],
    authMethods: [{ id: 'existing', label: '저장된 인증정보', probe: 'unsupported' }],
  };
}

export interface ConnectionAssistantPreviewInput {
  actorUserId: number;
  connectionId: string;
  connectionDisplayName: string;
  source: ConnectionSource;
  sourceId: string;
  projectId: string;
  projectName: string;
  provider?: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  action: ConnectionAssistantAction;
  expiresAt?: string;
}

export interface ConnectionAssistantPreview {
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  action: ConnectionAssistantAction;
  connection: { id: string; displayName: string; provider: string; capabilities: string[] };
  project: { id: string; name: string };
  impact: string;
  risk: 'low' | 'medium' | 'high';
  confirmationRequired: true;
  recommendedNextAction: 'confirm' | 'review';
}

function canonical(input: ConnectionAssistantPreviewInput, expiresAt: string) {
  return {
    actorUserId: input.actorUserId,
    connectionId: input.connectionId,
    source: input.source,
    sourceId: input.sourceId,
    projectId: input.projectId,
    action: input.action,
    expiresAt,
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function previewConnectionChange(input: ConnectionAssistantPreviewInput): ConnectionAssistantPreview {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString();
  const manifest = connectionManifest(input.provider);
  const proposalHash = digest(canonical(input, expiresAt));
  return {
    intentId: randomUUID(),
    proposalHash,
    expiresAt,
    action: input.action,
    connection: { id: input.connectionId, displayName: input.connectionDisplayName, provider: manifest.provider, capabilities: manifest.capabilities },
    project: { id: input.projectId, name: input.projectName },
    impact: input.action === 'connect'
      ? `${input.projectName} 프로젝트에서 ${input.connectionDisplayName} 연결을 사용할 수 있게 합니다.`
      : `${input.projectName} 프로젝트에서 ${input.connectionDisplayName} 연결 사용을 차단합니다.`,
    risk: input.riskLevel,
    confirmationRequired: true,
    recommendedNextAction: input.riskLevel === 'high' ? 'review' : 'confirm',
  };
}

export function verifyConnectionChange(input: ConnectionAssistantPreviewInput & {
  proposalHash: string;
  confirmed: boolean;
}): { mode: 'allow' | 'deny'; metadata: Record<string, unknown> } {
  if (input.confirmed !== true) throw Object.assign(new Error('Explicit confirmation required'), { code: 'CONFIRMATION_REQUIRED' });
  const expiresAt = input.expiresAt;
  if (!expiresAt || Date.parse(expiresAt) <= Date.now()) throw Object.assign(new Error('Connection preview expired'), { code: 'INTENT_EXPIRED' });
  const expected = digest(canonical(input, expiresAt));
  if (expected !== input.proposalHash) throw Object.assign(new Error('Connection preview changed'), { code: 'PROPOSAL_MISMATCH' });
  return {
    mode: input.action === 'connect' ? 'allow' : 'deny',
    metadata: {
      connection_assistant: true,
      connection_id: input.connectionId,
      proposal_hash: input.proposalHash,
      confirmed_at: new Date().toISOString(),
    },
  };
}
