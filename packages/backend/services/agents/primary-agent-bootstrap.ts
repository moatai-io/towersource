/**
 * Owns: expanding a minimal Primary Agent bootstrap request into a server-owned provisional Staffing Package.
 * Public API: buildPrimaryAgentBootstrapPayload, loadPrimaryAgentBootstrapPayload.
 */
import { queryOne } from '../../db/pg-repo.js';
import type { PrimaryAgentStaffingPayload } from './primary-agent-creation-intent.js';

export interface PrimaryAgentBootstrapInput {
  name: string;
  face: string;
  expertiseIntent: string;
}

interface DefaultHarnessRow {
  harness_id: string;
  harness_version: number;
  runtime_profile_id: string;
  runtime_profile_version: number;
  staffing_capability_ids: unknown;
}

const BOOTSTRAP_BOUNDARY = '다른 Workspace 접근, Credential 사용, 외부 발송·게시, 삭제·대량 변경, 비용 발생, 운영환경 변경은 별도 권한과 실행 시점 확인이 필요합니다.';

function requiredText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters`);
  return trimmed;
}

async function resolveDefaultPrimaryAgentHarness(): Promise<DefaultHarnessRow> {
  const row = await queryOne<DefaultHarnessRow>(
    `SELECT h.id AS harness_id,v.version AS harness_version,
            rp.profile_id AS runtime_profile_id,rp.profile_version AS runtime_profile_version,
            v.staffing_capability_ids
       FROM harnesses h
       JOIN harness_versions v
         ON v.harness_id=h.id AND v.version=h.current_version AND v.status='published'
       JOIN harness_runtime_profile_versions rp
         ON rp.harness_id=v.harness_id AND rp.harness_version=v.version
        AND rp.profile_id='standard' AND rp.status='active'
      WHERE h.id='tower-default' AND h.visibility='system' AND h.status='active'`,
  );
  if (!row) throw new Error('Default Primary Agent Harness is unavailable');
  return row;
}

/** Deterministically expand a minimal request without treating expertise intent as a finalized role. */
export async function buildPrimaryAgentBootstrapPayload(input: PrimaryAgentBootstrapInput): Promise<{
  payload: PrimaryAgentStaffingPayload;
  card: { name: string; face: string; expertiseIntent: string; profileStatus: 'ready'; harnessSummary: string; approvalBoundary: string };
}> {
  const name = requiredText(input.name, 'name', 120);
  const face = requiredText(input.face, 'face', 120);
  const expertiseIntent = requiredText(input.expertiseIntent, 'expertiseIntent', 1000);
  const harness = await resolveDefaultPrimaryAgentHarness();
  const capabilities = Array.isArray(harness.staffing_capability_ids)
    ? [...new Set(harness.staffing_capability_ids.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort()
    : [];

  const payload: PrimaryAgentStaffingPayload = {
    name,
    description: `${expertiseIntent}을(를) 잘 수행하는 AI 팀원의 Workspace`,
    face,
    tagline: `${expertiseIntent}을(를) 잘하는 팀원입니다.`,
    role: `“${expertiseIntent}”을(를) 중심으로 사용자의 실제 업무를 수행합니다.`,
    promise: '불필요한 인터뷰보다 실제 업무와 유용한 결과를 우선하겠습니다.',
    instruction: `사용자가 기대하는 핵심 전문성은 “${expertiseIntent}”입니다. 이 방향에 맞춰 사용자의 실제 요청을 정확하고 실용적으로 수행하세요. 별도의 입사 인터뷰나 온보딩 절차를 시작하지 마세요. 공통 작업 방식, 질문 기준, 권한과 안전 경계는 시스템 지침을 따르세요.`,
    firstMission: '사용자의 첫 실제 업무를 수행하기',
    authorityPolicy: { externalActions: 'confirm', destructiveActions: 'confirm', crossProjectAccess: 'explicit-target-and-acl' },
    toolPolicy: { harnessSelection: 'server-default', privilegedPlatformActions: 'forbidden' },
    capabilityRequirements: { required: capabilities, approvalConditions: [BOOTSTRAP_BOUNDARY] },
    harnessBinding: {
      harnessId: harness.harness_id,
      harnessVersion: Number(harness.harness_version),
      runtimeProfileId: harness.runtime_profile_id,
      runtimeProfileVersion: Number(harness.runtime_profile_version),
    },
    creationMode: 'bootstrap',
    sourceExpertiseIntent: expertiseIntent,
  };
  return {
    payload,
    card: {
      name,
      face,
      expertiseIntent,
      profileStatus: 'ready',
      harnessSummary: 'Tower의 공통 기본 업무 환경에서 바로 실제 업무를 시작합니다.',
      approvalBoundary: BOOTSTRAP_BOUNDARY,
    },
  };
}

/** Load only an unexpired bootstrap intent owned by this actor and source Project. */
export async function loadPrimaryAgentBootstrapPayload(input: {
  approvalIntentId: string;
  actorUserId: number;
  sourceProjectId: string;
  staffingHash: string;
  idempotencyKey: string;
}): Promise<PrimaryAgentStaffingPayload> {
  const row = await queryOne<{ staffing_payload: PrimaryAgentStaffingPayload }>(
    `SELECT i.staffing_payload
       FROM primary_agent_creation_intents i
       LEFT JOIN primary_agent_creation_commands c ON c.id=i.consumed_by_command_id
      WHERE i.id=$1 AND i.actor_user_id=$2 AND i.source_project_id=$3 AND i.staffing_hash=$4
        AND (
          (i.expires_at>NOW() AND i.consumed_by_command_id IS NULL)
          OR (c.actor_user_id=$2 AND c.source_project_id=$3 AND c.idempotency_key=$5)
        )`,
    [input.approvalIntentId, input.actorUserId, input.sourceProjectId, input.staffingHash, input.idempotencyKey],
  );
  if (!row?.staffing_payload || row.staffing_payload.creationMode !== 'bootstrap') {
    throw new Error('Valid unused server-approved bootstrap intent required');
  }
  return row.staffing_payload;
}
