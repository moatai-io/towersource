import { towerHttpUrl, readBrowserAuthToken } from '../client-connection/connection';

export interface SecretariatProposal {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  delivery?: 'popup' | 'inbox';
  shownAt?: string | null;
  sessionId: string | null;
  projectId: string | null;
}

export interface SecretariatSnapshot {
  enabled: boolean;
  pausedReason: string | null;
  proposals: SecretariatProposal[];
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function parseSecretariatSnapshot(value: unknown): SecretariatSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid secretariat response');
  const data = value as Record<string, unknown>;
  if (typeof data.enabled !== 'boolean' || !isNullableString(data.pausedReason) || !Array.isArray(data.proposals)) {
    throw new Error('Invalid secretariat response');
  }
  const proposals = data.proposals.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid proposal');
    const proposal = value as Record<string, unknown>;
    if (typeof proposal.id !== 'string' || !proposal.id || typeof proposal.title !== 'string'
      || typeof proposal.body !== 'string' || typeof proposal.createdAt !== 'string'
      || !isNullableString(proposal.readAt) || !isNullableString(proposal.sessionId)
      || !isNullableString(proposal.projectId)) throw new Error('Invalid proposal');
    return proposal as unknown as SecretariatProposal;
  });
  return { enabled: data.enabled, pausedReason: data.pausedReason, proposals };
}

async function request(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
  const token = readBrowserAuthToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(towerHttpUrl(`/api/secretariat${path}`), {
    method, headers, signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Secretariat request failed (${response.status})`);
  return response;
}

export async function loadSecretariat(signal?: AbortSignal): Promise<SecretariatSnapshot> {
  return parseSecretariatSnapshot(await (await request('', 'GET', undefined, signal)).json());
}

// Mutation responses need not return a snapshot. Re-fetch the account-owned state.
export async function updateSecretariatEnabled(enabled: boolean, signal?: AbortSignal): Promise<void> {
  await request('', 'PATCH', { enabled }, signal);
}

export async function readSecretariatProposal(id: string, signal?: AbortSignal): Promise<void> {
  await request(`/proposals/${encodeURIComponent(id)}/read`, 'POST', undefined, signal);
}

export function respondSecretariat(id: string, action: 'show' | 'skip' | 'today', signal?: AbortSignal) {
  return request(`/proposals/${encodeURIComponent(id)}/respond`, 'POST', { action }, signal);
}

export async function requestBriefing(signal?: AbortSignal): Promise<{ status: string; proposalId: string | null }> {
  return (await request('/briefing', 'POST', {}, signal)).json();
}
