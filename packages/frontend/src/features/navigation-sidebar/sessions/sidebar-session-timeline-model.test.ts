import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { buildSidebarSessionTimelineModel, sidebarSessionDateLabel } from './sidebar-session-timeline-model';

const project = (id: string, name = id) => ({ id, name } as Project);
const session = (id: string, updatedAt: string, projectId: string | null = null) => ({ id, updatedAt, projectId } as SessionMeta);
const labels = { now: new Date(2026, 7, 10, 12), locale: 'ko-KR', todayLabel: '오늘', yesterdayLabel: '어제' };

describe('Sidebar Session timeline model', () => {
  it('오늘과 어제 날짜 라벨을 현재 날짜 기준으로 만든다', () => {
    expect(sidebarSessionDateLabel('2026-08-10T09:00:00', labels)).toBe('오늘');
    expect(sidebarSessionDateLabel('2026-08-09T23:00:00', labels)).toBe('어제');
  });

  it('같은 날짜에 연속한 동일 Project Session만 하나의 run으로 묶는다', () => {
    const sessions = [session('a', '2026-08-10T11:00:00', 'p1'), session('b', '2026-08-10T10:00:00', 'p1')];
    const runs = buildSidebarSessionTimelineModel({ sessions, projects: [project('p1')], ...labels });
    expect(runs).toHaveLength(1);
    expect(runs[0].sessions.map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('다른 Project가 사이에 끼면 동일 Project도 별도 run으로 유지한다', () => {
    const sessions = [session('a', '2026-08-10T11:00:00', 'p1'), session('b', '2026-08-10T10:00:00', 'p2'), session('c', '2026-08-10T09:00:00', 'p1')];
    const runs = buildSidebarSessionTimelineModel({ sessions, projects: [project('p1'), project('p2')], ...labels });
    expect(runs.map(({ sessions: grouped }) => grouped.map(({ id }) => id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('Project 없는 Session과 삭제된 Project 참조는 서로 묶지 않는다', () => {
    const sessions = [session('a', '2026-08-10T11:00:00'), session('b', '2026-08-10T10:00:00', 'missing')];
    const runs = buildSidebarSessionTimelineModel({ sessions, projects: [], ...labels });
    expect(runs.map(({ key }) => key)).toEqual(['session:a', 'session:b']);
    expect(runs.every(({ project: owner }) => owner === null)).toBe(true);
  });

  it('입력 Session 순서를 변경하지 않는다', () => {
    const sessions = [session('new', '2026-08-10T11:00:00', 'p1'), session('old', '2026-08-09T11:00:00', 'p1')];
    const before = [...sessions];
    const runs = buildSidebarSessionTimelineModel({ sessions, projects: [project('p1')], ...labels });
    expect(sessions).toEqual(before);
    expect(runs.flatMap(({ sessions: grouped }) => grouped.map(({ id }) => id))).toEqual(['new', 'old']);
  });
});
