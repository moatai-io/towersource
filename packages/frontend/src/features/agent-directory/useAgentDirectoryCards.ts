import React from 'react';
import type { AgentDirectoryEntry, Project } from '@tower/shared';
import { useConfirm } from '../../hooks/useDialog';
import { getCurrentRole } from '../../utils/auth';
import { useProjectStore } from '../../stores/project-store';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}` });

/** Discovery stays a safe DTO; participation uses the existing admin/operator join API. */
export function useAgentDirectoryCards(onOpenProject: (project: Project) => void, isAdmin = false) {
  const confirm = useConfirm();
  const role = getCurrentRole();
  const canParticipate = isAdmin || role === 'admin' || role === 'operator';
  const [agents, setAgents] = React.useState<AgentDirectoryEntry[]>([]);
  const [administratorAgents, setAdministratorAgents] = React.useState<AgentDirectoryEntry[]>([]);
  const [joinable, setJoinable] = React.useState<Set<string>>(new Set());
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [inventoryLoading, setInventoryLoading] = React.useState(canParticipate);
  const entryInFlight = React.useRef(false);
  const [participationUnavailable, setParticipationUnavailable] = React.useState(false);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [entryError, setEntryError] = React.useState(false);
  const [contact, setContact] = React.useState<string | null>(null);
  const [revision, refresh] = React.useReducer(n => n + 1, 0);

  React.useEffect(() => {
    const controller = new AbortController();
    setStatus('loading'); setInventoryLoading(canParticipate); setAgents([]); setAdministratorAgents([]); setJoinable(new Set()); setParticipationUnavailable(false);
    fetch('/api/agent-directory', { headers: headers(), signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('directory unavailable');
      const data = await response.json();
      if (!controller.signal.aborted) { setAgents(Array.isArray(data.agents) ? data.agents : []); setStatus('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    if (canParticipate) {
      // The invited-only directory cannot discover nonmembers. Reuse the existing
      // admin/operator inventory, retaining safe DTO fields only (never paths/counts).
      fetch('/api/admin/agents?status=active', { headers: headers(), signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('participation unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) {
          const inventory = (Array.isArray(data.agents) ? data.agents : [])
            .filter((agent: { id: string; name: string; isMember: boolean; lifecycleStatus: string }) =>
              typeof agent.id === 'string' && typeof agent.name === 'string' && agent.isMember === false && agent.lifecycleStatus === 'active');
          setJoinable(new Set(inventory.map((agent: { id: string }) => agent.id)));
          setAdministratorAgents(inventory.map((agent: { id: string; name: string; ownerUsername?: string }) => ({
            projectId: agent.id, name: agent.name.slice(0, 120), shortRole: null,
            contactName: agent.ownerUsername?.slice(0, 120) || null, access: 'contact',
          })));
        }
      }).catch(() => { if (!controller.signal.aborted) setParticipationUnavailable(true); })
        .finally(() => { if (!controller.signal.aborted) setInventoryLoading(false); });
    }
    return () => controller.abort();
  }, [canParticipate, revision]);

  React.useEffect(() => {
    window.addEventListener('tower-agent-directory-changed', refresh);
    window.addEventListener('tower-administrator-participation-changed', refresh);
    return () => {
      window.removeEventListener('tower-agent-directory-changed', refresh);
      window.removeEventListener('tower-administrator-participation-changed', refresh);
    };
  }, []);

  async function open(agent: AgentDirectoryEntry, copy: { title: string; message: string; confirmText: string }) {
    if (entryInFlight.current) return;
    const needsJoin = canParticipate && joinable.has(agent.projectId);
    if (!needsJoin && agent.access === 'contact') { setContact(agent.projectId); return; }
    entryInFlight.current = true;
    if (needsJoin && !await confirm(copy)) { entryInFlight.current = false; return; }
    setOpening(agent.projectId); setEntryError(false); setContact(null);
    try {
      if (needsJoin) {
        const joined = await fetch(`/api/admin/agents/${encodeURIComponent(agent.projectId)}/join`, { method: 'POST', headers: headers() });
        if (!joined.ok) throw new Error('participation denied');
        window.dispatchEvent(new Event('tower-administrator-participation-changed'));
      }
      // A successful join is not a Project DTO. Always recheck the normal project ACL.
      const response = await fetch(`/api/projects/${encodeURIComponent(agent.projectId)}`, { headers: headers() });
      if (!response.ok) throw new Error('entry denied');
      const data = await response.json();
      const project = data.project as Project | undefined;
      if (!project || project.id !== agent.projectId) throw new Error('project unavailable');
      if (!useProjectStore.getState().projects.some(item => item.id === project.id)) useProjectStore.getState().addProject(project);
      onOpenProject(project);
    } catch { setEntryError(true); }
    finally { entryInFlight.current = false; setOpening(null); }
  }
  const cards = [...new Map([...administratorAgents, ...agents].map(agent => [agent.projectId, agent])).values()];
  return { agents: cards, joinable, status: inventoryLoading && status === 'ready' ? 'loading' as const : status, participationUnavailable, opening, entryError, contact, open, refresh };
}
