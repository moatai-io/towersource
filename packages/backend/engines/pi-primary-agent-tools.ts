import { preserveAgentExecutionAuthority } from '../services/authority/agent-authority-policy-update.js';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { execute, query, queryOne } from '../db/pg-repo.js';
import { isProjectOwner } from '../services/pm/project-membership-manager.js';
import { config } from '../config.js';
import { createPrimaryAgentCommand } from '../services/agents/primary-agent-creation.js';
import { createPrimaryAgentCreationIntent, primaryAgentStaffingHash } from '../services/agents/primary-agent-creation-intent.js';
import { validatePrimaryAgentHarnessBinding } from '../services/agents/primary-agent-staffing.js';
import { ensureProjectAgentInstruction } from '../services/pm/project-agent-instruction.js';

interface Context { userId?: number; userRole?: string; projectId?: string; }
interface ProfilePatch { displayName?: string; face?: string; tagline?: string; role?: string; promise?: string; instruction?: string; authorityPolicy?: Record<string, unknown>; toolPolicy?: Record<string, unknown>; }
const HarnessBindingSchema = Type.Object({
  harnessId: Type.String({ minLength: 1 }),
  harnessVersion: Type.Integer({ minimum: 1 }),
  runtimeProfileId: Type.String({ minLength: 1 }),
  runtimeProfileVersion: Type.Integer({ minimum: 1 }),
});
const CapabilityRequirementsSchema = Type.Object({
  required: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  optional: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  forbidden: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  dataSources: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  externalActions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  approvalConditions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
const RoiContractSchema = Type.Optional(Type.Object({
  primaryMetric: Type.String({ minLength: 1 }),
  baseline: Type.Optional(Type.String({ maxLength: 1000 })),
  target: Type.String({ minLength: 1, maxLength: 1000 }),
  confidence: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  reviewAfterDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
}));
const StaffingFields = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  face: Type.String({ minLength: 1, maxLength: 120, description: 'Emoji or character:<id> identity reference.' }),
  tagline: Type.String({ minLength: 1, maxLength: 300 }),
  role: Type.String({ minLength: 1, maxLength: 1000 }),
  promise: Type.String({ minLength: 1, maxLength: 1000 }),
  instruction: Type.String({ minLength: 1, maxLength: 12000 }),
  firstMission: Type.String({ minLength: 1, maxLength: 1000 }),
  authorityPolicy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  toolPolicy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  roiContract: RoiContractSchema,
  capabilityRequirements: CapabilityRequirementsSchema,
  harnessBinding: HarnessBindingSchema,
};
const Params = Type.Object({
  ...StaffingFields,
  approvalIntentId: Type.String({ minLength: 1, description: 'Server-issued approval intent returned by preview_primary_agent_staffing.' }),
  staffingHash: Type.String({ minLength: 64, maxLength: 64, description: 'Exact hash returned by preview_primary_agent_staffing and approved by the user.' }),
  confirmed: Type.Boolean({ description: 'Must be true only after the user explicitly approved the complete Staffing Package.' }),
});
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], isError, details: undefined });
function creationPayload(p: any) {
  return {
    name: p.name, description: p.description, face: p.face, tagline: p.tagline,
    role: p.role, promise: p.promise, instruction: p.instruction, firstMission: p.firstMission,
    authorityPolicy: p.authorityPolicy, toolPolicy: p.toolPolicy, roiContract: p.roiContract,
    capabilityRequirements: p.capabilityRequirements, harnessBinding: p.harnessBinding,
  };
}

async function assertPrimaryAgentCreationContext(ctx: Context): Promise<string | null> {
  if (ctx.userRole === 'guest' || ctx.userRole === 'viewer') return `Role ${ctx.userRole} cannot manage Primary Agents.`;
  const source = await queryOne<{ id: string }>('SELECT id FROM projects WHERE id = $1 AND (archived IS NULL OR archived = 0)', [ctx.projectId]);
  if (!source) return 'This tool requires an active source Project.';
  return null;
}

async function assertProfileUpdateContext(ctx: Context, targetProjectId: string): Promise<string | null> {
  if (ctx.userRole === 'guest' || ctx.userRole === 'viewer') return `Role ${ctx.userRole} cannot manage Primary Agents.`;
  if (ctx.userRole === 'admin' || ctx.userRole === 'operator') return null;
  if (!ctx.userId || !(await isProjectOwner(targetProjectId, ctx.userId))) {
    return 'Only the Project owner, admin or operator can apply Primary Agent Profile and AGENTS.md changes.';
  }
  return null;
}

async function loadEditableProfile(ctx: Context, targetProjectId: string) {
  return queryOne<any>(
    `SELECT p.id AS project_id, p.name AS project_name, p.root_path,
            pap.display_name, pap.face, pap.tagline, pap.role, pap.promise, pap.instruction,
            pap.instruction_version, pap.authority_policy, pap.tool_policy
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2
       LEFT JOIN project_agent_profiles pap ON pap.project_id=p.id
      WHERE p.id=$1 AND (p.archived IS NULL OR p.archived=0)`,
    [targetProjectId, ctx.userId],
  );
}

const UpdateParams = Type.Object({
  targetProjectId: Type.String({ minLength: 1 }),
  confirmed: Type.Boolean({ description: 'True only after the user reviewed and approved the before/after preview.' }),
  expectedVersion: Type.Integer({ minimum: 1, description: 'Version shown in the approved preview; prevents stale overwrite.' }),
  changes: Type.Object({
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    face: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    tagline: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    promise: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 12000 })),
    authorityPolicy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    toolPolicy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
});

export function createPrimaryAgentProfileTools(ctx: Context): ToolDefinition[] {
  if (!config.agentFirstEnabled || !ctx.userId || !ctx.projectId) return [];
  const preview: ToolDefinition = {
    name: 'preview_primary_agent_profile_update', label: 'Preview Primary Agent Profile Update',
    description: 'Prepare a before/after preview for an existing Primary AI teammate without changing it.',
    promptSnippet: 'Use preview_primary_agent_profile_update before proposing name, character, role, promise, instruction, or policy changes.',
    parameters: Type.Object({ targetProjectId: Type.String({ minLength: 1 }), changes: UpdateParams.properties.changes }),
    async execute(_id: string, p: { targetProjectId: string; changes: ProfilePatch }) {
      const denied = await assertProfileUpdateContext(ctx, p.targetProjectId); if (denied) return result(denied, true);
      const row = await loadEditableProfile(ctx, p.targetProjectId);
      if (!row?.instruction_version) return result('Target Project has no explicit Primary Agent Profile.', true);
      let authorityPolicy: Record<string, unknown>;
      try { authorityPolicy = preserveAgentExecutionAuthority(row.authority_policy || {}, p.changes.authorityPolicy); }
      catch (error) { return result((error as Error).message, true); }
      const before = { displayName: row.display_name, face: row.face, tagline: row.tagline, role: row.role, promise: row.promise, instruction: row.instruction, authorityPolicy: row.authority_policy || {}, toolPolicy: row.tool_policy || {} };
      return result(JSON.stringify({ ok: true, targetProjectId: p.targetProjectId, currentVersion: row.instruction_version, before, after: { ...before, ...p.changes, authorityPolicy }, existingSessionsKeepPinnedVersion: true }, null, 2));
    },
  } as ToolDefinition;
  const update: ToolDefinition = {
    name: 'update_primary_agent_profile', label: 'Update Primary Agent Profile',
    description: 'Apply a user-approved Primary AI teammate profile/character update and increment its version. Existing Session snapshots stay unchanged.',
    promptSnippet: 'Call update_primary_agent_profile only after showing the preview and receiving explicit user approval.',
    parameters: UpdateParams,
    async execute(_id: string, p: { targetProjectId: string; confirmed: boolean; expectedVersion: number; changes: ProfilePatch }) {
      if (!p.confirmed) return result('Update refused: explicit preview approval is required.', true);
      const denied = await assertProfileUpdateContext(ctx, p.targetProjectId); if (denied) return result(denied, true);
      const row = await loadEditableProfile(ctx, p.targetProjectId);
      if (!row?.instruction_version) return result('Target Project has no explicit Primary Agent Profile.', true);
      let authorityPolicy: Record<string, unknown>;
      try { authorityPolicy = preserveAgentExecutionAuthority(row.authority_policy || {}, p.changes.authorityPolicy); }
      catch (error) { return result((error as Error).message, true); }
      const next = {
        displayName: row.display_name,
        face: row.face,
        tagline: row.tagline,
        role: row.role,
        promise: row.promise,
        instruction: row.instruction,
        toolPolicy: row.tool_policy || {},
        ...p.changes,
        authorityPolicy,
      };
      try {
        ensureProjectAgentInstruction(row.root_path, next);
      } catch (error: any) {
        return result(`Update refused: Project AGENTS.md could not be synchronized: ${error?.message || error}`, true);
      }
      const changed = await execute(
        `UPDATE project_agent_profiles SET display_name=$1, face=$2, tagline=$3, role=$4, promise=$5, instruction=$6,
          authority_policy=$7::jsonb, tool_policy=$8::jsonb, instruction_version=instruction_version+1,
          instruction_source='owner-approved-profile-update', updated_at=NOW()
         WHERE project_id=$9 AND instruction_version=$10`,
        [next.displayName, next.face, next.tagline, next.role, next.promise, next.instruction, JSON.stringify(next.authorityPolicy), JSON.stringify(next.toolPolicy), p.targetProjectId, p.expectedVersion],
      );
      if (!changed.changes) {
        try {
          ensureProjectAgentInstruction(row.root_path, {
            displayName: row.display_name, face: row.face, tagline: row.tagline,
            role: row.role, promise: row.promise, instruction: row.instruction,
          });
        } catch (error: any) {
          return result(`Update refused: Profile changed after preview and AGENTS.md rollback failed: ${error?.message || error}`, true);
        }
        return result('Update refused: Profile changed after preview. Create a new preview.', true);
      }
      return result(JSON.stringify({ ok: true, targetProjectId: p.targetProjectId, previousVersion: p.expectedVersion, profileVersion: p.expectedVersion + 1, existingSessionsKeepPinnedVersion: true }, null, 2));
    },
  } as ToolDefinition;
  return [preview, update];
}

export function createPrimaryAgentStaffingTools(ctx: Context): ToolDefinition[] {
  if (!config.agentFirstEnabled || !ctx.userId || !ctx.projectId) return [];

  const recommend: ToolDefinition = {
    name: 'recommend_agent_harness',
    label: 'Recommend Agent Harness',
    description: 'Compare published Harnesses against an AI teammate capability requirement and return least-privilege fit cards. This does not bind or create anything.',
    promptSnippet: 'Use recommend_agent_harness after the role is concrete enough to name required and forbidden capabilities.',
    parameters: Type.Object({ requirements: CapabilityRequirementsSchema }),
    async execute(_id: string, p: any) {
      const denied = await assertPrimaryAgentCreationContext(ctx);
      if (denied) return result(denied, true);
      const rows = await query<any>(`SELECT h.id,h.name,h.description,h.visibility,h.current_version,
          v.engine,v.effective_manifest,v.staffing_capability_ids,p.profile_id AS runtime_profile_id,p.profile_version
        FROM harnesses h
        JOIN harness_versions v ON v.harness_id=h.id AND v.version=h.current_version AND v.status='published'
        JOIN harness_runtime_profile_versions p ON p.harness_id=v.harness_id AND p.harness_version=v.version AND p.status='active'
        WHERE h.status='active' AND (h.visibility='system' OR h.owner_project_id=$1)
        ORDER BY h.name`, [ctx.projectId]);
      const required = [...new Set<string>(p.requirements.required || [])];
      const optional = [...new Set<string>(p.requirements.optional || [])];
      const forbidden = [...new Set<string>(p.requirements.forbidden || [])];
      const candidates = rows.map((row: any) => {
        const provided: string[] = Array.isArray(row.staffing_capability_ids) ? row.staffing_capability_ids : [];
        const missingRequired = required.filter((id) => !provided.includes(id));
        const forbiddenPresent = forbidden.filter((id) => provided.includes(id));
        const extraCapabilities = provided.filter((id) => !required.includes(id) && !optional.includes(id));
        const matched = required.filter((id) => provided.includes(id)).length;
        const score = Math.max(0, Math.round(100 * (required.length ? matched / required.length : 1) - forbiddenPresent.length * 40 - extraCapabilities.length * 5));
        return {
          harnessId: row.id,
          harnessVersion: Number(row.current_version),
          runtimeProfileId: row.runtime_profile_id,
          runtimeProfileVersion: Number(row.profile_version),
          name: row.name,
          description: row.description,
          engine: row.engine,
          providedCapabilities: provided,
          missingRequired,
          forbiddenPresent,
          extraCapabilities,
          fit: missingRequired.length === 0 && forbiddenPresent.length === 0
            ? (extraCapabilities.length === 0 ? 'exact' : 'restricted-fit')
            : 'not-fit',
          score,
        };
      }).sort((a: any, b: any) => b.score - a.score || a.extraCapabilities.length - b.extraCapabilities.length);
      const usable = candidates.filter((candidate: any) => candidate.fit !== 'not-fit');
      return result(JSON.stringify({
        ok: true,
        requirements: p.requirements,
        recommendation: usable[0] || null,
        customHarnessRequired: usable.length === 0,
        candidates,
      }, null, 2));
    },
  } as ToolDefinition;

  const preview: ToolDefinition = {
    name: 'preview_primary_agent_staffing',
    label: 'Preview Primary Agent Staffing',
    description: 'Validate and preview the complete Staffing Package: Employee Card, ROI, Harness fit, authority, operating instruction, and first mission. This makes no changes.',
    promptSnippet: 'Show the returned Staffing Package and staffingHash to the user before creating the Primary Agent.',
    parameters: Type.Object(StaffingFields),
    async execute(_id: string, p: any) {
      const denied = await assertPrimaryAgentCreationContext(ctx);
      if (denied) return result(denied, true);
      const binding = p.harnessBinding;
      let fit: Awaited<ReturnType<typeof validatePrimaryAgentHarnessBinding>>;
      try {
        fit = await validatePrimaryAgentHarnessBinding({ sourceProjectId: ctx.projectId!, binding, requirements: p.capabilityRequirements });
      } catch (error: any) {
        return result(JSON.stringify({ ok: false, reason: error?.message || String(error), ...(error?.details || {}) }, null, 2), true);
      }
      const packageHash = primaryAgentStaffingHash(creationPayload(p));
      const intent = await createPrimaryAgentCreationIntent({
        actorUserId: ctx.userId!,
        actorRole: ctx.userRole || 'member',
        sourceProjectId: ctx.projectId!,
        payload: creationPayload(p),
      });
      return result(JSON.stringify({
        ok: true,
        staffingPackageHash: packageHash,
        staffingHash: intent.staffingHash,
        approvalIntentId: intent.approvalIntentId,
        approvalIntentExpiresAt: intent.expiresAt,
        employeeCard: { name: p.name, face: p.face, tagline: p.tagline, role: p.role, promise: p.promise },
        roiContract: p.roiContract || null,
        harnessFitCard: { ...binding, ...fit },
        authorityCard: { authorityPolicy: p.authorityPolicy || {}, toolPolicy: p.toolPolicy || {}, approvalConditions: p.capabilityRequirements.approvalConditions || [] },
        operatingPreview: p.instruction,
        firstMission: p.firstMission,
        initialInterviewNotice: '생성 후 승인된 세션 모델로 짧은 첫 안내를 자동 실행합니다. 모델 사용량이 발생하며 중지할 수 있습니다. 도구·웹 조회 없이 질문 하나 또는 실행안을 표시합니다. 먼저 대화를 시작하면 생략합니다.',
        existingSessionsAffected: false,
        nextAction: 'Show this complete package to the user and call create_primary_agent_project only after explicit approval.',
      }, null, 2));
    },
  } as ToolDefinition;

  return [recommend, preview];
}

export function createPrimaryAgentProjectTool(ctx: Context): ToolDefinition | null {
  if (!config.agentFirstEnabled || !ctx.userId || !ctx.projectId) return null;
  return {
    name: 'create_primary_agent_project',
    label: 'Create Primary Agent Project',
    description: 'Create a new Primary Agent Project from a user-approved Staffing Package using the shared idempotent creation command.',
    promptSnippet: 'Only after explicit user approval of preview_primary_agent_staffing, use create_primary_agent_project with the exact staffingHash and Harness binding.',
    promptGuidelines: [
      'Never call this while exploring roles or drafting a Staffing Package.',
      'Show the complete Staffing Package and obtain explicit approval first; set confirmed=true only then.',
      'Pass the exact staffingHash returned by preview_primary_agent_staffing without modifying any field.',
      'Do not silently substitute tower-default or another Harness.',
      'Do not create Helper Agents through this tool.',
    ],
    parameters: Params,
    async execute(_id: string, p: any) {
      if (!p.confirmed) return result('Creation refused: explicit Staffing Package approval is required.', true);
      const denied = await assertPrimaryAgentCreationContext(ctx);
      if (denied) return result(`Creation refused: ${denied}`, true);
      const expectedHash = primaryAgentStaffingHash(creationPayload(p));
      if (p.staffingHash !== expectedHash) return result('Creation refused: Staffing Package changed after preview. Create a new preview and obtain approval again.', true);
      try {
        const created = await createPrimaryAgentCommand({
          idempotencyKey: `staffing:${ctx.userId}:${expectedHash}`,
          actorUserId: ctx.userId!,
          sourceProjectId: ctx.projectId!,
          approvedCardHash: expectedHash,
          approvalIntentId: p.approvalIntentId,
          name: p.name,
          description: p.description,
          face: p.face,
          tagline: p.tagline,
          role: p.role,
          promise: p.promise,
          instruction: p.instruction,
          firstMission: p.firstMission,
          authorityPolicy: p.authorityPolicy,
          toolPolicy: p.toolPolicy,
          roiContract: p.roiContract,
          capabilityRequirements: p.capabilityRequirements,
          harnessBinding: p.harnessBinding,
        });
        return result(JSON.stringify({ ...created, approvedStaffingHash: expectedHash }, null, 2));
      } catch (err: any) {
        return result(`Primary Agent Project creation failed: ${err?.message || err}`, true);
      }
    },
  } as ToolDefinition;
}
