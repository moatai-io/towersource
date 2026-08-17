// Owns: Sidebar 최근 Session timeline의 날짜 라벨과 인접 Project run 계산. Public API: buildSidebarSessionTimelineModel. See ../README.md.
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';

export interface SidebarSessionTimelineRun {
  key: string;
  dateKey: string;
  dateLabel: string;
  project: Project | null;
  sessions: SessionMeta[];
}

interface BuildSidebarSessionTimelineModelInput {
  sessions: SessionMeta[];
  projects: Project[];
  now: Date;
  locale: string;
  todayLabel: string;
  yesterdayLabel: string;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** 현재 날짜와 locale을 기준으로 timeline 날짜 제목을 만든다. */
export function sidebarSessionDateLabel(raw: string, input: Pick<BuildSidebarSessionTimelineModelInput, 'now' | 'locale' | 'todayLabel' | 'yesterdayLabel'>): string {
  const date = new Date(raw);
  const today = input.now;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOffset = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (dayOffset === 0) return input.todayLabel;
  if (dayOffset === 1) return input.yesterdayLabel;
  return new Intl.DateTimeFormat(input.locale, { month: 'short', day: 'numeric', weekday: 'short' }).format(date);
}

/** 전역 최근순을 재정렬하지 않고 같은 날짜의 인접한 동일 Project Session만 run으로 묶는다. */
export function buildSidebarSessionTimelineModel(input: BuildSidebarSessionTimelineModelInput): SidebarSessionTimelineRun[] {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  return input.sessions.reduce<SidebarSessionTimelineRun[]>((runs, session) => {
    const project = session.projectId ? projectsById.get(session.projectId) ?? null : null;
    const updatedAt = new Date(session.updatedAt);
    const dateKey = localDateKey(updatedAt);
    const key = project?.id ?? `session:${session.id}`;
    const previous = runs[runs.length - 1];
    if (previous?.key === key && previous.dateKey === dateKey) previous.sessions.push(session);
    else runs.push({
      key,
      dateKey,
      dateLabel: sidebarSessionDateLabel(session.updatedAt, input),
      project,
      sessions: [session],
    });
    return runs;
  }, []);
}
