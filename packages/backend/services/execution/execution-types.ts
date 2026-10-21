export type ExecutionSourceKind = 'automation' | 'manual' | 'agent' | 'webhook' | 'system';
export type ExecutionScopeKind = 'project' | 'system' | 'personal';
export type ExecutionAdapterKind = 'legacy_task' | 'ai_session' | 'runtime_box' | 'webhook' | 'host' | 'system';
export type ExecutionStatus =
  | 'queued'
  | 'admitted'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'uncertain';

export const TERMINAL_EXECUTION_STATUSES = new Set<ExecutionStatus>([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'uncertain',
]);

export interface ExecutionRecord {
  id: string;
  sourceKind: ExecutionSourceKind;
  sourceId: string | null;
  sourceRunId: string | null;
  scopeKind: ExecutionScopeKind;
  projectId: string | null;
  actorUserId: number | null;
  status: ExecutionStatus;
  adapterKind: ExecutionAdapterKind;
  engine: string | null;
  model: string | null;
  sessionId: string | null;
  executorRef: string | null;
  parentExecutionId: string | null;
  attempt: number;
  idempotencyKey: string;
  inputJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  summaryText: string | null;
  errorJson: Record<string, unknown> | null;
  admittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdmitExecutionInput {
  sourceKind: ExecutionSourceKind;
  sourceId?: string | null;
  sourceRunId?: string | null;
  scopeKind: ExecutionScopeKind;
  projectId?: string | null;
  actorUserId?: number | null;
  adapterKind: ExecutionAdapterKind;
  engine?: string | null;
  model?: string | null;
  parentExecutionId?: string | null;
  attempt?: number;
  idempotencyKey: string;
  inputJson?: Record<string, unknown>;
}

export interface ExecutionTransitionInput {
  executionId: string;
  expectedStatuses: ExecutionStatus[];
  toStatus: ExecutionStatus;
  eventType: string;
  actorType?: string;
  actorId?: string | null;
  sessionId?: string | null;
  executorRef?: string | null;
  resultJson?: Record<string, unknown> | null;
  summaryText?: string | null;
  errorJson?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
}
