import { create } from 'zustand';

export type AIServiceStatus = 'draft' | 'review' | 'active' | 'paused' | 'retired';
export type AIServiceChannelAccessMode = 'public' | 'unlisted' | 'password' | 'login_required' | 'disabled';
export interface AIServicePublicUiConfig { showInfoPanel?: boolean; showTools?: boolean; showMaterials?: boolean; showTiming?: boolean }

export interface AIServiceActivationReadiness { ok: boolean; reason?: string; code?: string }
export interface AIServiceConversationSummary {
  id: string;
  runtimeSessionId: string | null;
  sessionName: string | null;
  tenantKey: string;
  userKey: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalTokens: number;
}
export interface AIServiceChannelUsageSummary {
  serviceId: string;
  channelId: string;
  windowSeconds: number;
  channelLimit: number;
  tenantLimit: number;
  tenantDailyLimit: number;
  tokenLimit: number;
  totalTokens: number;
  channelMessageTurns: number;
  channelDailyMessageTurns: number;
  credentialIssued: number;
  conversationsCreated: number;
  uniqueTenants: number;
  topTenant?: { tenantKey: string; messageTurns: number } | null;
  quota: { channelRemaining: number; channelRatio: number; status: 'ok' | 'near' | 'exceeded' };
}

export interface AIServiceSummary {
  id: string;
  name: string;
  description: string;
  ownerProjectId?: string;
  ownerProjectRootPath?: string | null;
  ownerAgentName?: string;
  ownerAgentFace?: string;
  ownerAgentProfileVersion?: number;
  serviceType: 'customer' | 'partner' | 'employee' | 'public' | 'api';
  status: AIServiceStatus;
  currentDeployment?: { id: string; version: number; status: string; sourceSnapshot?: { kind?: string; refs?: Array<{ path?: string; title?: string; size?: number; sha256?: string }> }; policySnapshot?: { harnessBinding?: { harnessId?: string; harnessVersion?: number; runtimeProfileId?: string; runtimeProfileVersion?: number; engine?: string; model?: string; status?: string }; allowedTools?: string[]; [key: string]: unknown }; experienceSnapshot?: Record<string, unknown>; evaluationSnapshot?: Record<string, unknown>; deployedAt?: string | null; createdAt?: string } | null;
  latestDeployment?: { id: string; version: number; status: string } | null;
  deployments?: Array<{ id: string; version: number; status: string; deployedAt?: string | null; createdAt?: string }>;
  latest_deployment?: { id: string; version: number; status: string } | null;
  latestEvaluation?: { id: string; status: string; evaluatedAt: string; harnessId: string; harnessVersion: number; runtimeProfileId: string; runtimeProfileVersion: number } | null;
  latest_evaluation?: { id: string; status: string; evaluatedAt: string; harnessId: string; harnessVersion: number; runtimeProfileId: string; runtimeProfileVersion: number } | null;
  channels?: Array<{ id: string; name: string; channelType: string; status: string; accessMode?: AIServiceChannelAccessMode; hasPassword?: boolean; publicUi?: AIServicePublicUiConfig }>;
  metrics?: { conversations?: number; unresolved?: number; cost?: number };
  updatedAt?: string;
}

type Filter = 'all' | 'active' | 'draft' | 'review' | 'paused';

interface AIServiceState {
  services: AIServiceSummary[];
  loading: boolean;
  error: string | null;
  filter: Filter;
  mutatingId: string | null;
  setFilter: (filter: Filter) => void;
  load: () => Promise<void>;
  pause: (id: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  retire: (id: string) => Promise<void>;
  updateService: (id: string, input: { name?: string; description?: string }) => Promise<void>;
  submitDeployment: (serviceId: string, deploymentId: string) => Promise<void>;
  approveDeployment: (serviceId: string, deploymentId: string) => Promise<void>;
  activateDeployment: (serviceId: string, deploymentId: string) => Promise<void>;
  createDeployment: (serviceId: string, snapshots: { sourceSnapshot: unknown; policySnapshot: unknown; experienceSnapshot: unknown; evaluationSnapshot: unknown; refreshIdentityFromSourceAgent?: boolean }) => Promise<{ id: string; version: number; status: string }>;
  deployNow: (serviceId: string, deploymentId?: string) => Promise<void>;
  rollbackDeployment: (serviceId: string, deploymentId: string) => Promise<void>;
  checkActivationReadiness: (serviceId: string, deploymentId: string) => Promise<AIServiceActivationReadiness>;
  getChannelUsage: (serviceId: string, channelId: string) => Promise<AIServiceChannelUsageSummary>;
  getConversations: (serviceId: string) => Promise<AIServiceConversationSummary[]>;
  updateChannelQuota: (serviceId: string, channelId: string, limits: { windowSeconds: number; channelLimit: number; tenantLimit: number; tenantDailyLimit: number; tokenLimit: number }) => Promise<AIServiceChannelUsageSummary>;
  updateChannelAccess: (serviceId: string, channelId: string, input: { mode: AIServiceChannelAccessMode; password?: string; ui?: AIServicePublicUiConfig }) => Promise<void>;
  createWebLinkChannel: (serviceId: string, name?: string) => Promise<void>;
}

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(!!init?.body), ...(init?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const useAIServiceStore = create<AIServiceState>((set, get) => ({
  services: [], loading: false, error: null, filter: 'all', mutatingId: null,
  setFilter: (filter) => set({ filter }),
  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api('/api/ai-services');
      set({ services: Array.isArray(data.services) ? data.services : [] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'AI 서비스를 불러오지 못했습니다.' });
    } finally { set({ loading: false }); }
  },
  pause: async (id) => {
    set({ mutatingId: id });
    try { await api(`/api/ai-services/${encodeURIComponent(id)}/pause`, { method: 'POST' }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  revoke: async (id) => {
    set({ mutatingId: id });
    try { await api(`/api/ai-services/${encodeURIComponent(id)}/revoke`, { method: 'POST' }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  retire: async (id) => {
    set({ mutatingId: id });
    try { await api(`/api/ai-services/${encodeURIComponent(id)}`, { method: 'DELETE' }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  updateService: async (id, input) => {
    set({ mutatingId: id });
    try { await api(`/api/ai-services/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  submitDeployment: async (serviceId, deploymentId) => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/deployments/${encodeURIComponent(deploymentId)}/submit`, { method: 'POST' }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  approveDeployment: async (serviceId, deploymentId) => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/deployments/${encodeURIComponent(deploymentId)}/approve`, { method: 'POST' }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  activateDeployment: async (serviceId, deploymentId) => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/deployments/${encodeURIComponent(deploymentId)}/activate`, { method: 'POST' }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  createDeployment: async (serviceId, snapshots) => api(`/api/ai-services/${encodeURIComponent(serviceId)}/deployments`, { method: 'POST', body: JSON.stringify(snapshots) }),
  deployNow: async (serviceId, deploymentId) => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/deploy-now`, { method: 'POST', body: JSON.stringify({ deploymentId }) }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  rollbackDeployment: async (serviceId, deploymentId) => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/rollback`, { method: 'POST', body: JSON.stringify({ deploymentId }) }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  checkActivationReadiness: async (serviceId, deploymentId) => api(`/api/ai-services/${encodeURIComponent(serviceId)}/deployments/${encodeURIComponent(deploymentId)}/activation-readiness`),
  getChannelUsage: async (serviceId, channelId) => api(`/api/ai-services/${encodeURIComponent(serviceId)}/channels/${encodeURIComponent(channelId)}/usage`),
  getConversations: async (serviceId) => {
    const data = await api(`/api/ai-services/${encodeURIComponent(serviceId)}/conversations`);
    return Array.isArray(data.conversations) ? data.conversations : [];
  },
  updateChannelQuota: async (serviceId, channelId, limits) => {
    await api(`/api/ai-services/${encodeURIComponent(serviceId)}/channels/${encodeURIComponent(channelId)}/quota`, { method: 'PUT', body: JSON.stringify(limits) });
    return get().getChannelUsage(serviceId, channelId);
  },
  updateChannelAccess: async (serviceId, channelId, input) => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/channels/${encodeURIComponent(channelId)}/access`, { method: 'PUT', body: JSON.stringify(input) }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
  createWebLinkChannel: async (serviceId, name = 'API serving channel') => {
    set({ mutatingId: serviceId });
    try { await api(`/api/ai-services/${encodeURIComponent(serviceId)}/channels/web-link`, { method: 'POST', body: JSON.stringify({ name }) }); await get().load(); }
    finally { set({ mutatingId: null }); }
  },
}));
