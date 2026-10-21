import type { Project } from '../../stores/project-store';

/** Rename the visible Agent identity, never its backing Project/storage name. */
export async function renameAgentDisplayName(projectId: string, displayName: string, failureMessage: string): Promise<Project> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api/projects/${projectId}/agent-profile`, {
    method: 'PATCH', headers, body: JSON.stringify({ displayName: displayName.trim() }),
  });
  const project = await response.json().catch(() => null);
  if (!response.ok || project?.id !== projectId || !project?.agent?.displayName) throw new Error(failureMessage);
  return project;
}
