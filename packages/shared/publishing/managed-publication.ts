/** Proposed management contract. Not a grant, not proof of deployment/health. */
export interface ManagedPublication {
  version: 1;
  id: string;
  ownerProjectId: string;
  title: string;
  kind: 'static-page' | 'html-dashboard' | 'host-dashboard';
  artifactRevision: string;
  datasetIds: string[];
  serviceId?: string;
  controlRoom: boolean;
}
export interface DatasetRefreshState {
  sourceAsOf: string | null;
  lastSuccessAt: string | null;
  lastAttempt: 'never' | 'running' | 'succeeded' | 'failed';
  staleAfterMs: number;
}
export type DatasetHealth = 'unknown' | 'refreshing' | 'failed' | 'stale' | 'fresh';
/** Freshness is derived from source time, never file mtime or last successful run alone. */
export function datasetHealth(state: DatasetRefreshState, nowMs: number): DatasetHealth {
  if (state.lastAttempt === 'failed') return 'failed';
  if (state.lastAttempt === 'running') return 'refreshing';
  if (state.lastAttempt === 'never') return 'unknown';
  const source = state.sourceAsOf ? Date.parse(state.sourceAsOf) : NaN;
  const success = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(source) || !Number.isFinite(success) || source > nowMs || success > nowMs || !Number.isFinite(state.staleAfterMs) || state.staleAfterMs <= 0) return 'unknown';
  return nowMs-source > state.staleAfterMs ? 'stale' : 'fresh';
}
/** Caller must provide only server-authorized publications. Client filtering is never ACL. */
export function publicationsForAgent(authorized: readonly ManagedPublication[], projectId: string): ManagedPublication[] {
  return authorized.filter(publication => publication.ownerProjectId === projectId);
}
