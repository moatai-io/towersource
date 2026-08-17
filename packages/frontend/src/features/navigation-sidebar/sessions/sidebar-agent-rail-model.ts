// Owns: Sidebar Agent rail의 Project별 Session 수집과 pin/activity 정렬. Public API: buildSidebarAgentRailModel. See ../README.md.
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { sidebarSessionTimestampMs } from './sidebar-session-list-model';

export interface SidebarAgentRailGroup {
  project: Project;
  sessions: SessionMeta[];
}

interface BuildSidebarAgentRailModelInput {
  projects: Project[];
  sessions: SessionMeta[];
}

function projectPinOrder(project: Project): number {
  return project.pinOrder ?? 9999;
}

function groupActivityMs(group: SidebarAgentRailGroup): number {
  return Math.max(
    sidebarSessionTimestampMs(group.project.createdAt),
    ...group.sessions.map((session) => sidebarSessionTimestampMs(session.updatedAt)),
  );
}

/** Conversation filter와 독립적인 Agent rail group을 계산한다. */
export function buildSidebarAgentRailModel(input: BuildSidebarAgentRailModelInput): SidebarAgentRailGroup[] {
  const sessionsByProject = new Map<string, SessionMeta[]>();
  for (const session of input.sessions) {
    if (!session.projectId) continue;
    const projectSessions = sessionsByProject.get(session.projectId) ?? [];
    projectSessions.push(session);
    sessionsByProject.set(session.projectId, projectSessions);
  }

  const groups = input.projects.map((project) => ({
    project,
    sessions: [...(sessionsByProject.get(project.id) ?? [])].sort(
      (a, b) => sidebarSessionTimestampMs(b.updatedAt) - sidebarSessionTimestampMs(a.updatedAt),
    ),
  }));

  return groups.sort((a, b) => {
    const pinDelta = Number(b.project.pinned) - Number(a.project.pinned);
    if (pinDelta !== 0) return pinDelta;
    if (a.project.pinned && b.project.pinned) {
      const orderDelta = projectPinOrder(a.project) - projectPinOrder(b.project);
      if (orderDelta !== 0) return orderDelta;
    }
    return groupActivityMs(b) - groupActivityMs(a) || a.project.sortOrder - b.project.sortOrder;
  });
}
