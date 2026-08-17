import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatUserRuntimeBoxBudgetError,
  listUserRuntimeBoxOccupancy,
  selectReclaimableRuntimeBox,
  type RuntimeBoxOccupancy,
} from './runtime-box-reclamation.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
import { query } from '../../db/pg-repo.js';


import { formatServiceList } from './service-registry.js';

beforeEach(() => vi.clearAllMocks());

function occupancy(overrides: Partial<RuntimeBoxOccupancy> = {}): RuntimeBoxOccupancy {
  return {
    id: 1,
    project_id: 'project-1',
    project_name: '오래된 프로젝트',
    status: 'running',
    last_active_at: '2026-07-15T01:00:00.000Z',
    started_at: '2026-07-15T00:00:00.000Z',
    idle_stop_minutes: 20,
    active_service_count: 0,
    seconds_until_idle_stop: -60,
    ...overrides,
  };
}

describe('listUserRuntimeBoxOccupancy', () => {
  it('normalizes persisted BIGINT box ids before returning occupancy', async () => {
    vi.mocked(query).mockResolvedValueOnce([occupancy({ id: '62' as unknown as number })] as any);
    await expect(listUserRuntimeBoxOccupancy(7, 75)).resolves.toMatchObject([{ id: 62 }]);
  });
});

describe('selectReclaimableRuntimeBox', () => {
  it('selects the oldest already-idle running box without active services', () => {
    const oldest = occupancy({ id: 1, project_name: '가장 오래된 프로젝트' });
    const newer = occupancy({ id: 2, project_name: '덜 오래된 프로젝트' });

    expect(selectReclaimableRuntimeBox([oldest, newer])).toBe(oldest);
  });

  it('never reclaims boxes with active/pending services, recent activity, missing activity, or starting state', () => {
    expect(selectReclaimableRuntimeBox([
      occupancy({ id: 1, active_service_count: 1 }),
      occupancy({ id: 2, seconds_until_idle_stop: 1 }),
      occupancy({ id: 3, last_active_at: null, seconds_until_idle_stop: null }),
      occupancy({ id: 4, status: 'starting', seconds_until_idle_stop: -600 }),
    ])).toBeUndefined();
  });
});

describe('formatUserRuntimeBoxBudgetError', () => {
  it('shows only caller occupancy with project, last activity, remaining idle time, and resolution', () => {
    const message = formatUserRuntimeBoxBudgetError({
      current: 2,
      limit: 2,
      occupancy: [
        occupancy({ project_name: '최근 문서 작업', seconds_until_idle_stop: 61 }),
        occupancy({ id: 2, project_name: '개발 서버', active_service_count: 1 }),
      ],
    });

    expect(message).toContain('현재 2개 running/starting (한도 2)');
    expect(message).toContain('최근 문서 작업');
    expect(message).toContain('마지막 활동 2026-07-15T01:00:00.000Z');
    expect(message).toContain('자동 종료 가능까지 약 2분 남음');
    expect(message).toContain('개발 서버');
    expect(message).toContain('실행/시작 중 서비스 1개');
    expect(message).toContain('더 이상 쓰지 않는 프로젝트의 Runtime Box를 먼저 중지');
  });
});

describe('formatServiceList', () => {
  it('distinguishes zero services from Runtime Box slot occupancy', () => {
    expect(formatServiceList([])).toContain('Runtime Box 자체는 idle-stop 시각까지 warm 상태');
  });
});
