import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../stores/session-store';
import type { Project } from '../../../stores/project-store';
import { buildSidebarAgentRailModel } from './sidebar-agent-rail-model';

const project = (id: string, options: Partial<Project> = {}) => ({
  id,
  name: id,
  createdAt: '2026-08-01 00:00:00',
  sortOrder: 0,
  pinned: false,
  ...options,
} as Project);
const session = (id: string, projectId: string | null, updatedAt: string) => ({ id, projectId, updatedAt } as SessionMeta);

describe('Sidebar Agent rail model', () => {
  it('각 Project의 Session을 최근 활동순으로 모은다', () => {
    const result = buildSidebarAgentRailModel({
      projects: [project('p1')],
      sessions: [session('old', 'p1', '2026-08-01 10:00:00'), session('new', 'p1', '2026-08-02T10:00:00Z')],
    });
    expect(result[0].sessions.map(({ id }) => id)).toEqual(['new', 'old']);
  });

  it('Conversation filter 없이 Session이 없는 Project도 유지한다', () => {
    const result = buildSidebarAgentRailModel({ projects: [project('empty')], sessions: [] });
    expect(result).toHaveLength(1);
    expect(result[0].sessions).toEqual([]);
  });

  it('고정 Project를 활동 시점보다 우선하고 pinOrder를 적용한다', () => {
    const result = buildSidebarAgentRailModel({
      projects: [
        project('active', { createdAt: '2026-08-10 00:00:00' }),
        project('pin-late', { pinned: true, pinOrder: 2 }),
        project('pin-first', { pinned: true, pinOrder: 1 }),
      ],
      sessions: [session('recent', 'active', '2026-08-10 12:00:00')],
    });
    expect(result.map(({ project: owner }) => owner.id)).toEqual(['pin-first', 'pin-late', 'active']);
  });

  it('고정되지 않은 Project는 최신 Session 또는 생성 시점으로 정렬한다', () => {
    const result = buildSidebarAgentRailModel({
      projects: [project('created', { createdAt: '2026-08-08 00:00:00' }), project('session-active')],
      sessions: [session('recent', 'session-active', '2026-08-09 00:00:00')],
    });
    expect(result.map(({ project: owner }) => owner.id)).toEqual(['session-active', 'created']);
  });

  it('입력 Project와 Session 배열을 변경하지 않는다', () => {
    const projects = [project('p1'), project('p2')];
    const sessions = [session('a', 'p2', '2026-08-02 00:00:00'), session('b', 'p1', '2026-08-01 00:00:00')];
    const projectOrder = projects.map(({ id }) => id);
    const sessionOrder = sessions.map(({ id }) => id);
    buildSidebarAgentRailModel({ projects, sessions });
    expect(projects.map(({ id }) => id)).toEqual(projectOrder);
    expect(sessions.map(({ id }) => id)).toEqual(sessionOrder);
  });
});
