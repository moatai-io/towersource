import type { ActionReceipt, BusinessObjectSchema, BusinessObjectSummary, RecordDetail, RecordList } from './diy-erp-connector';
import type { WorkspaceAppBuilderDraftPreview, WorkspaceAppDefinition } from './workspace-app-definition';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export interface WorkspaceAppQueryResult {
  columns: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
}

export interface FrappeConnectionReadiness {
  ready: boolean;
  provider: 'frappe';
  siteHost: string;
  deskHost?: string;
  hasApiKey: boolean;
  hasApiSecret: boolean;
}

export async function fetchFrappeConnectionReadiness(input: {
  projectId: string | null;
  connectionId: string;
}): Promise<FrappeConnectionReadiness | null> {
  if (!input.projectId || !input.connectionId) return null;
  const params = new URLSearchParams({ projectId: input.projectId });
  const res = await fetch(`/api/workspace-apps/connectors/frappe/connections/${encodeURIComponent(input.connectionId)}/readiness?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Frappe readiness request failed: ${res.status}`);
  return data?.readiness ?? null;
}


export async function fetchFrappeObjects(input: {
  projectId: string | null;
  connectionId: string;
  search?: string;
  limit?: number;
}): Promise<BusinessObjectSummary[]> {
  if (!input.projectId || !input.connectionId) return [];
  const params = new URLSearchParams({ projectId: input.projectId, limit: String(input.limit ?? 80) });
  if (input.search) params.set('search', input.search);
  const res = await fetch(`/api/workspace-apps/connectors/frappe/connections/${encodeURIComponent(input.connectionId)}/doctypes?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Frappe DocType list request failed: ${res.status}`);
  return Array.isArray(data?.objects) ? data.objects as BusinessObjectSummary[] : [];
}

export async function fetchFrappeObjectSchema(input: {
  projectId: string | null;
  connectionId: string;
  doctype: string;
}): Promise<BusinessObjectSchema | null> {
  if (!input.projectId || !input.connectionId || !input.doctype) return null;
  const params = new URLSearchParams({ projectId: input.projectId });
  const res = await fetch(`/api/workspace-apps/connectors/frappe/connections/${encodeURIComponent(input.connectionId)}/doctypes/${encodeURIComponent(input.doctype)}?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Frappe schema request failed: ${res.status}`);
  return data?.schema ?? null;
}

export async function fetchFrappeRecords(input: {
  projectId: string | null;
  connectionId: string;
  doctype: string;
  fields?: string[];
  search?: string;
  limit?: number;
}): Promise<RecordList | null> {
  if (!input.projectId || !input.connectionId || !input.doctype) return null;
  const params = new URLSearchParams({ projectId: input.projectId, limit: String(input.limit ?? 100) });
  if (input.fields?.length) params.set('fields', input.fields.join(','));
  if (input.search) params.set('search', input.search);
  const res = await fetch(`/api/workspace-apps/connectors/frappe/connections/${encodeURIComponent(input.connectionId)}/doctypes/${encodeURIComponent(input.doctype)}/records?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Frappe records request failed: ${res.status}`);
  return data?.records ?? null;
}

export async function fetchFrappeRecord(input: {
  projectId: string | null;
  connectionId: string;
  doctype: string;
  recordId: string;
}): Promise<RecordDetail | null> {
  if (!input.projectId || !input.connectionId || !input.doctype || !input.recordId) return null;
  const params = new URLSearchParams({ projectId: input.projectId });
  const res = await fetch(`/api/workspace-apps/connectors/frappe/connections/${encodeURIComponent(input.connectionId)}/doctypes/${encodeURIComponent(input.doctype)}/records/${encodeURIComponent(input.recordId)}?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Frappe record request failed: ${res.status}`);
  return data?.record ?? null;
}

export async function fetchMockFrappeObjects(projectId: string | null): Promise<BusinessObjectSummary[]> {
  if (!projectId) return [];
  const params = new URLSearchParams({ projectId });
  const res = await fetch(`/api/workspace-apps/connectors/frappe/mock/objects?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Mock Frappe objects request failed: ${res.status}`);
  return Array.isArray(data?.objects) ? data.objects as BusinessObjectSummary[] : [];
}

export async function fetchMockFrappeObjectSchema(input: {
  projectId: string | null;
  objectId: string;
}): Promise<BusinessObjectSchema | null> {
  if (!input.projectId || !input.objectId) return null;
  const params = new URLSearchParams({ projectId: input.projectId });
  const res = await fetch(`/api/workspace-apps/connectors/frappe/mock/objects/${encodeURIComponent(input.objectId)}?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Mock Frappe schema request failed: ${res.status}`);
  return data?.schema ?? null;
}

export async function fetchMockFrappeRecords(input: {
  projectId: string | null;
  objectId: string;
  search?: string;
  limit?: number;
}): Promise<RecordList | null> {
  if (!input.projectId || !input.objectId) return null;
  const params = new URLSearchParams({ projectId: input.projectId, limit: String(input.limit ?? 100) });
  if (input.search) params.set('search', input.search);
  const res = await fetch(`/api/workspace-apps/connectors/frappe/mock/objects/${encodeURIComponent(input.objectId)}/records?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Mock Frappe records request failed: ${res.status}`);
  return data?.records ?? null;
}

export async function fetchMockFrappeRecord(input: {
  projectId: string | null;
  objectId: string;
  recordId: string;
}): Promise<RecordDetail | null> {
  if (!input.projectId || !input.objectId || !input.recordId) return null;
  const params = new URLSearchParams({ projectId: input.projectId });
  const res = await fetch(`/api/workspace-apps/connectors/frappe/mock/objects/${encodeURIComponent(input.objectId)}/records/${encodeURIComponent(input.recordId)}?${params.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Mock Frappe record request failed: ${res.status}`);
  return data?.record ?? null;
}

export async function runMockFrappeAction(input: {
  projectId: string | null;
  objectId: string;
  actionId: string;
  recordId?: string;
  values?: Record<string, string | number | boolean | null>;
}): Promise<ActionReceipt | null> {
  if (!input.projectId || !input.objectId || !input.actionId) return null;
  const res = await fetch(`/api/workspace-apps/connectors/frappe/mock/objects/${encodeURIComponent(input.objectId)}/actions/${encodeURIComponent(input.actionId)}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ projectId: input.projectId, recordId: input.recordId, values: input.values ?? {} }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Mock Frappe action failed: ${res.status}`);
  return data?.receipt ?? null;
}

export interface WorkspaceAppActionReceipt {
  id: string;
  appId: string;
  actionId: string;
  actionType: 'create' | 'update' | 'change-status' | 'export';
  projectId: string;
  actorUserId: number;
  provider: 'sqlite';
  table: string;
  recordId?: string;
  changedFields: string[];
  executedAt: string;
  status: 'applied';
}

export async function executeWorkspaceAppAction(input: {
  projectId: string | null;
  appId: string;
  actionId: string;
  payload: {
    values?: Record<string, string | number | boolean | null>;
    recordId?: string | number;
  };
}): Promise<WorkspaceAppActionReceipt | null> {
  if (!input.projectId || !input.actionId) return null;
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/actions/${encodeURIComponent(input.actionId)}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ projectId: input.projectId, payload: input.payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps action failed: ${res.status}`);
  return data?.receipt ?? null;
}

export async function fetchWorkspaceAppDefinitions(projectId: string | null): Promise<WorkspaceAppDefinition[]> {
  if (!projectId) return [];
  const params = new URLSearchParams({ projectId });
  const res = await fetch(`/api/workspace-apps?${params.toString()}`, { headers: authHeaders() });
  if (res.status === 404) return [];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps request failed: ${res.status}`);
  return Array.isArray(data?.apps) ? data.apps as WorkspaceAppDefinition[] : [];
}

export interface WorkspaceAppDraftRecord {
  id: string;
  appId: string;
  projectId: string;
  baseSourcePath?: string;
  createdAt: string;
  actorUserId: number;
  status: 'draft';
  draftPreview: WorkspaceAppBuilderDraftPreview;
}

export type WorkspaceAppDraftSaveResult = WorkspaceAppDraftRecord;

export interface WorkspaceAppPublishPreview {
  appId: string;
  draftId: string;
  sourcePath: string;
  beforeHash: string;
  afterHash: string;
  previewHash: string;
  changes: WorkspaceAppBuilderDraftPreview['changes'];
  beforeText: string;
  afterText: string;
}

export interface WorkspaceAppPublishResult {
  id: string;
  appId: string;
  draftId: string;
  sourcePath: string;
  beforeHash: string;
  afterHash: string;
  previewHash: string;
  actorUserId: number;
  publishedAt: string;
  status: 'published';
}

export async function fetchWorkspaceAppDrafts(input: {
  projectId: string | null;
  appId: string;
  limit?: number;
}): Promise<WorkspaceAppDraftRecord[]> {
  if (!input.projectId) return [];
  const params = new URLSearchParams({ projectId: input.projectId, limit: String(input.limit ?? 10) });
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/drafts?${params.toString()}`, { headers: authHeaders() });
  if (res.status === 404) return [];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps drafts request failed: ${res.status}`);
  return Array.isArray(data?.drafts) ? data.drafts as WorkspaceAppDraftRecord[] : [];
}

export async function fetchWorkspaceAppDraft(input: {
  projectId: string | null;
  appId: string;
  draftId: string;
}): Promise<WorkspaceAppDraftRecord | null> {
  if (!input.projectId || !input.draftId) return null;
  const params = new URLSearchParams({ projectId: input.projectId });
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/drafts/${encodeURIComponent(input.draftId)}?${params.toString()}`, { headers: authHeaders() });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps draft request failed: ${res.status}`);
  return data?.draft ?? null;
}

export async function createWorkspaceAppPublishPreview(input: {
  projectId: string | null;
  appId: string;
  draftId: string;
}): Promise<WorkspaceAppPublishPreview | null> {
  if (!input.projectId || !input.draftId) return null;
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/drafts/${encodeURIComponent(input.draftId)}/publish-preview`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ projectId: input.projectId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps publish preview failed: ${res.status}`);
  return data?.preview ?? null;
}

export async function publishWorkspaceAppDraft(input: {
  projectId: string | null;
  appId: string;
  draftId: string;
  previewHash: string;
  expectedBeforeHash: string;
  confirmed: true;
}): Promise<WorkspaceAppPublishResult | null> {
  if (!input.projectId || !input.draftId || !input.previewHash || !input.expectedBeforeHash) return null;
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/drafts/${encodeURIComponent(input.draftId)}/publish`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      projectId: input.projectId,
      previewHash: input.previewHash,
      expectedBeforeHash: input.expectedBeforeHash,
      confirmed: input.confirmed,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps publish failed: ${res.status}`);
  return data?.publish ?? null;
}

export async function createWorkspaceAppDraft(input: {
  projectId: string | null;
  appId: string;
  draftPreview?: WorkspaceAppBuilderDraftPreview;
}): Promise<WorkspaceAppDraftSaveResult | null> {
  if (!input.projectId || !input.draftPreview) return null;
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/drafts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ projectId: input.projectId, draftPreview: input.draftPreview }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps draft save failed: ${res.status}`);
  return data?.draft ?? null;
}

export async function fetchWorkspaceAppQueryRows(input: {
  projectId: string | null;
  appId: string;
  queryId?: string;
}): Promise<WorkspaceAppQueryResult | null> {
  if (!input.projectId || !input.queryId) return null;
  const res = await fetch(`/api/workspace-apps/${encodeURIComponent(input.appId)}/query`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ projectId: input.projectId, queryId: input.queryId }),
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Workspace Apps query failed: ${res.status}`);
  return {
    columns: Array.isArray(data?.columns) ? data.columns : [],
    rows: Array.isArray(data?.rows) ? data.rows as Array<Record<string, string>> : [],
    rowCount: Number(data?.rowCount) || 0,
  };
}
