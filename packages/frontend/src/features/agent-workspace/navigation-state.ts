export type AgentWorkspaceLocation = 'home' | 'conversations' | 'files' | 'experts' | 'work';

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
}

export function getAgentWorkspaceLocation(projectId: string): AgentWorkspaceLocation {
  return read()[projectId] || 'home';
}
