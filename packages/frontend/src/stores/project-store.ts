import { towerHttpUrl } from '../features/client-connection/connection';
/**
 * Owns: project list state + per-(project,label) collapse state.
 * Public API: useProjectStore() — projects[], collapsedProjects, collapsedLabels,
 *             addProject / updateProject / removeProject / setProjects,
 *             isProjectCollapsed / toggleProjectCollapsed / toggleLabelCollapsed.
 *
 * The legacy `hiddenLabels` concept was removed on 2026-05-11
 * (see workspace/decisions/2026-05-11-remove-hide-keep-collapse-and-archive.md).
 * Sidebar deck visibility now uses only `expanded ↔ collapsed ↔ archived`.
 *
 * On first load after the upgrade we run a one-shot migration: any keys that
 * were in localStorage `hiddenLabels` are merged into `collapsedLabels` so the
 * user's intent ("get this deck out of my way") is preserved as a collapsed
 * header instead of a fully hidden one. Sentinel `hiddenLabels-migrated`
 * guarantees idempotency.
 */
import { create } from 'zustand';
export type { Project } from '@tower/shared';
import type { Project } from '@tower/shared';

interface ProjectState {
  projects: Project[];
  collapsedProjects: Set<string>;
  collapsedLabels: Set<string>;   // key = "projectId::label"

  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  removeProject: (id: string) => void;
  isProjectCollapsed: (projectId: string) => boolean;
  toggleProjectCollapsed: (projectId: string) => void;
  toggleLabelCollapsed: (projectId: string, label: string) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  movePinnedProject: (projectId: string, direction: 'up' | 'down') => void;
}

// Persist project group collapse overrides in localStorage.
//
// Mode pinned-open-v1:
//   - pinned projects default to expanded
//   - non-pinned projects default to collapsed
//   - collapsedProjects stores only exceptions from that default
//
// Older builds stored "explicitly collapsed ids" and defaulted every project to
// expanded. When this mode first loads, reset the old set so users get the new
// sane default instead of carrying ambiguous old state forward.
const PROJECT_COLLAPSE_MODE_KEY = 'collapsedProjects:mode';
const PROJECT_COLLAPSE_MODE = 'pinned-open-v1';

function defaultProjectCollapsed(project?: Project): boolean {
  return project ? !project.pinned : false;
}

function loadCollapsed(): Set<string> {
  try {
    const mode = localStorage.getItem(PROJECT_COLLAPSE_MODE_KEY);
    if (mode !== PROJECT_COLLAPSE_MODE) {
      localStorage.removeItem('collapsedProjects');
      localStorage.setItem(PROJECT_COLLAPSE_MODE_KEY, PROJECT_COLLAPSE_MODE);
      return new Set();
    }
    const raw = localStorage.getItem('collapsedProjects');
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveCollapsed(set: Set<string>) {
  localStorage.setItem('collapsedProjects', JSON.stringify([...set]));
  localStorage.setItem(PROJECT_COLLAPSE_MODE_KEY, PROJECT_COLLAPSE_MODE);
}

/**
 * Load `collapsedLabels`, then run the one-shot hidden-labels migration.
 * Any key that was in `hiddenLabels` is merged into `collapsedLabels` so the
 * deck still defaults to a collapsed header rather than appearing fully open.
 * Sentinel makes this idempotent across reloads.
 */
function loadCollapsedLabels(): Set<string> {
  const collapsed = new Set<string>();
  try {
    const raw = localStorage.getItem('collapsedLabels');
    if (raw) for (const k of JSON.parse(raw) as string[]) collapsed.add(k);
  } catch {}

  // One-shot migration from removed `hiddenLabels` concept (2026-05-11).
  if (!localStorage.getItem('hiddenLabels-migrated')) {
    try {
      const raw = localStorage.getItem('hiddenLabels');
      if (raw) {
        for (const k of JSON.parse(raw) as string[]) collapsed.add(k);
      }
    } catch {}
    localStorage.removeItem('hiddenLabels');
    localStorage.setItem('hiddenLabels-migrated', '1');
    // Persist the merged set immediately so subsequent reads reflect the merge.
    saveCollapsedLabels(collapsed);
  }
  return collapsed;
}

function saveCollapsedLabels(set: Set<string>) {
  localStorage.setItem('collapsedLabels', JSON.stringify([...set]));
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function sortedPinnedIds(projects: Project[]): string[] {
  return projects
    .filter((p) => p.pinned)
    .sort((a, b) => (a.pinOrder ?? 9999) - (b.pinOrder ?? 9999) || a.name.localeCompare(b.name))
    .map((p) => p.id);
}

async function persistPinnedProjects(projects: Project[]) {
  try {
    const res = await fetch(towerHttpUrl('/api/projects/pins'), {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ projectIds: sortedPinnedIds(projects) }),
    });
    if (!res.ok) console.warn('[project-store] failed to persist project pins', res.status);
  } catch (err) {
    console.warn('[project-store] failed to persist project pins', err);
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({ 
  projects: [],
  collapsedProjects: loadCollapsed(),
  collapsedLabels: loadCollapsedLabels(),

  setProjects: (projects) => {
    // Dedup incoming list by id (defense against any upstream duplication).
    // Kept as a Map to preserve order of first occurrence.
    const seen = new Map<string, Project>();
    for (const p of projects) if (!seen.has(p.id)) seen.set(p.id, p);
    set({ projects: [...seen.values()] });
  },
  // Idempotent upsert by id: POST responses and project_created WebSocket events
  // race during Primary Agent creation. The earlier event can carry a pre-profile
  // Project while the later response carries the Agent identity; merge the fresher
  // shape instead of dropping it or duplicating the sidebar group.
  addProject: (project) =>
    set((s) => {
      const index = s.projects.findIndex((p) => p.id === project.id);
      if (index < 0) return { projects: [...s.projects, project] };
      const projects = [...s.projects];
      projects[index] = { ...projects[index], ...project };
      return { projects };
    }),
  updateProject: (id, updates) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  removeProject: (id) => set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),
  pinProject: (projectId) => {
    let nextProjects: Project[] = [];
    set((s) => {
      const maxOrder = s.projects.reduce((max, p) => p.pinned ? Math.max(max, p.pinOrder ?? 0) : max, -1);
      nextProjects = s.projects.map((p) => p.id === projectId ? { ...p, pinned: true, pinOrder: maxOrder + 1 } : p);
      const nextCollapsed = new Set(s.collapsedProjects);
      // Pinning should adopt the pinned default (expanded), not preserve an
      // old non-pinned "expanded override" as a now-pinned "collapsed override".
      nextCollapsed.delete(projectId);
      saveCollapsed(nextCollapsed);
      return { projects: nextProjects, collapsedProjects: nextCollapsed };
    });
    void persistPinnedProjects(nextProjects);
  },
  unpinProject: (projectId) => {
    let nextProjects: Project[] = [];
    set((s) => {
      const remaining = s.projects
        .filter((p) => p.id !== projectId && p.pinned)
        .sort((a, b) => (a.pinOrder ?? 9999) - (b.pinOrder ?? 9999));
      const orderMap = new Map(remaining.map((p, i) => [p.id, i]));
      nextProjects = s.projects.map((p) => {
        if (p.id === projectId) return { ...p, pinned: false, pinOrder: null };
        if (orderMap.has(p.id)) return { ...p, pinOrder: orderMap.get(p.id)! };
        return p;
      });
      const nextCollapsed = new Set(s.collapsedProjects);
      // Unpinning should adopt the non-pinned default (collapsed).
      nextCollapsed.delete(projectId);
      saveCollapsed(nextCollapsed);
      return { projects: nextProjects, collapsedProjects: nextCollapsed };
    });
    void persistPinnedProjects(nextProjects);
  },
  movePinnedProject: (projectId, direction) => {
    let nextProjects: Project[] = [];
    set((s) => {
      const pinned = s.projects
        .filter((p) => p.pinned)
        .sort((a, b) => (a.pinOrder ?? 9999) - (b.pinOrder ?? 9999));
      const idx = pinned.findIndex((p) => p.id === projectId);
      if (idx < 0) return s;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= pinned.length) return s;
      const reordered = [...pinned];
      [reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]];
      const orderMap = new Map(reordered.map((p, i) => [p.id, i]));
      nextProjects = s.projects.map((p) => orderMap.has(p.id) ? { ...p, pinOrder: orderMap.get(p.id)! } : p);
      return { projects: nextProjects };
    });
    if (nextProjects.length > 0) void persistPinnedProjects(nextProjects);
  },
  isProjectCollapsed: (projectId) => {
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    const defaultCollapsed = defaultProjectCollapsed(project);
    return state.collapsedProjects.has(projectId) ? !defaultCollapsed : defaultCollapsed;
  },
  toggleProjectCollapsed: (projectId) =>
    set((s) => {
      const project = s.projects.find((p) => p.id === projectId);
      const defaultCollapsed = defaultProjectCollapsed(project);
      const currentCollapsed = s.collapsedProjects.has(projectId) ? !defaultCollapsed : defaultCollapsed;
      const nextCollapsedValue = !currentCollapsed;
      const next = new Set(s.collapsedProjects);
      if (nextCollapsedValue === defaultCollapsed) next.delete(projectId);
      else next.add(projectId);
      saveCollapsed(next);
      return { collapsedProjects: next };
    }),
  toggleLabelCollapsed: (projectId, label) =>
    set((s) => {
      const key = `${projectId}::${label}`;
      const next = new Set(s.collapsedLabels);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedLabels(next);
      return { collapsedLabels: next };
    }),
}));
