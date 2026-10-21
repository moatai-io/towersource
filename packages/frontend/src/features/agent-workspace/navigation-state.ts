export type AgentWorkspaceLocation = 'home' | 'conversations' | 'files' | 'experts' | 'work';

export const AGENT_WORKSPACE_LOCATION_EVENT = 'tower-agent-workspace-location';

const STORAGE_KEY = 'tower:agent-workspace:last-location:v1';

function storage(): Storage | null { return typeof localStorage === 'undefined' ? null : localStorage; }

function read(): Record<string, AgentWorkspaceLocation> {
  try {
    const target = storage();
    if (!target) return {};
    const value = JSON.parse(target.getItem(STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function rememberAgentWorkspaceLocation(projectId: string, location: AgentWorkspaceLocation): void {
  if (!projectId) return;
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [projectId]: location })); } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AGENT_WORKSPACE_LOCATION_EVENT, { detail: { projectId, location } }));
  }
}

export function getAgentWorkspaceLocation(projectId: string): AgentWorkspaceLocation {
  return read()[projectId] || 'home';
}
