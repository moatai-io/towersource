/**
 * runtime-box-reclamation.ts — 사용자별 Runtime Box 슬롯 점유 진단과 안전한 LRU 후보 선택.
 *
 * Owns: 같은 사용자의 Box 점유 목록 조회, reclaim 가능 여부 판정, 사용자용 한도 오류 설명.
 * Public API: listUserRuntimeBoxOccupancy, selectReclaimableRuntimeBox, formatUserRuntimeBoxBudgetError.
 * See README.md and _DECISIONS.md.
 */

import { normalizeRuntimeBoxId } from './runtime-box-row-normalization.js';
import { query } from '../../db/pg-repo.js';

export interface RuntimeBoxOccupancy {
  id: number;
  project_id: string;
  project_name: string;
  status: 'running' | 'starting';
  last_active_at: string | null;
  started_at: string | null;
  idle_stop_minutes: number;
  active_service_count: number;
  seconds_until_idle_stop: number | null;
}

/**
 * 사용자의 running/starting Box 점유를 오래 활동하지 않은 순서로 반환한다.
 * pending/running 서비스는 시작 중이거나 실제 실행 중인 장기 작업이므로 active로 센다.
 */
export async function listUserRuntimeBoxOccupancy(
  userId: number,
  targetBoxId: number,
): Promise<RuntimeBoxOccupancy[]> {
  const rows = await query<Omit<RuntimeBoxOccupancy, 'id'> & { id: unknown }>(
    `SELECT b.id,
            b.project_id,
            COALESCE(p.name, b.project_id) AS project_name,
            b.status,
            b.last_active_at,
            b.started_at,
            b.idle_stop_minutes,
            COUNT(s.id) FILTER (WHERE s.status IN ('pending', 'running'))::int AS active_service_count,
            CASE
              WHEN b.last_active_at IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (
                b.last_active_at + (b.idle_stop_minutes * interval '1 minute') - now()
              ))::double precision
            END AS seconds_until_idle_stop
       FROM project_runtime_boxes b
       LEFT JOIN projects p ON p.id = b.project_id
       LEFT JOIN runtime_box_services s ON s.box_id = b.id
      WHERE b.created_by = $1
        AND b.id <> $2
        AND b.status IN ('running', 'starting')
      GROUP BY b.id, p.name
      ORDER BY COALESCE(b.last_active_at, b.started_at, b.created_at) ASC, b.id ASC`,
    [userId, targetBoxId],
  );
  return rows.map(row => ({ ...row, id: normalizeRuntimeBoxId(row.id) }));
}

/** 가장 오래된, 이미 idle-stop 시각을 지난, active service 없는 running Box를 고른다. */
export function selectReclaimableRuntimeBox(
  occupancy: RuntimeBoxOccupancy[],
): RuntimeBoxOccupancy | undefined {
  return occupancy.find(box =>
    box.status === 'running' &&
    box.last_active_at !== null &&
    box.active_service_count === 0 &&
    box.seconds_until_idle_stop !== null &&
    box.seconds_until_idle_stop <= 0,
  );
}

function formatLastActivity(box: RuntimeBoxOccupancy): string {
  const value = box.last_active_at ?? box.started_at;
  if (!value) return '기록 없음';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function formatOccupancyReason(box: RuntimeBoxOccupancy): string {
  if (box.status === 'starting') return '시작 중이라 자동 종료하지 않음';
  if (box.active_service_count > 0) return `실행/시작 중 서비스 ${box.active_service_count}개가 있어 자동 종료하지 않음`;
  if (box.seconds_until_idle_stop === null) return '마지막 활동 기록이 없어 자동 종료하지 않음';
  if (box.seconds_until_idle_stop > 0) {
    return `자동 종료 가능까지 약 ${Math.max(1, Math.ceil(box.seconds_until_idle_stop / 60))}분 남음`;
  }
  return '유휴 종료 가능';
}

/** 다른 사용자의 정보 없이 현재 사용자가 점유한 프로젝트와 해결 방법을 설명한다. */
export function formatUserRuntimeBoxBudgetError(opts: {
  current: number;
  limit: number;
  occupancy: RuntimeBoxOccupancy[];
}): string {
  const details = opts.occupancy.length > 0
    ? opts.occupancy.map(box =>
      `- ${box.project_name}: 마지막 활동 ${formatLastActivity(box)}, ${formatOccupancyReason(box)}`,
    ).join('\n')
    : '- 점유 Box 상세 정보를 확인할 수 없습니다.';

  return [
    `사용자 Runtime Box 수 한도 초과: 현재 ${opts.current}개 running/starting (한도 ${opts.limit}).`,
    '현재 점유:',
    details,
    '실행 중인 서비스가 없는 Box도 warm 상태 동안 슬롯을 점유합니다. 남은 유휴 시간이 지나면 다시 시도하거나, 더 이상 쓰지 않는 프로젝트의 Runtime Box를 먼저 중지하세요.',
  ].join('\n');
}
