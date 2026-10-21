// Project Primary Agent profile helpers.
// Project remains the identity/ACL/filesystem anchor; this service maps an
// optional explicit profile row to the public API and derives a safe implicit
// profile for existing projects.

import { execute, queryOne } from '../../db/pg-repo.js';


export interface ProjectAgentProfilePublic {
  id: string;
  kind: 'primary';
  projectId: string;
  displayName: string;
  face: string;
  tagline: string | null;
  role: string | null;
  promise: string | null;
  profileVersion: number;
  instructionSource: string;
  defaultEngine: string | null;
  defaultModel: string | null;
  authorityPolicy: Record<string, unknown>;
  toolPolicy: Record<string, unknown>;
  memoryPolicy: Record<string, unknown>;
  budgetPolicy: Record<string, unknown>;
  status: string;
  onboardingState: string;
  careerLevel: 'intern' | 'practitioner' | 'manager' | 'partner';
  explicit: boolean;
}

export interface ProjectAgentRuntimeProfile extends ProjectAgentProfilePublic {
  instruction: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function projectAgentProfileFromRow(row: any): ProjectAgentProfilePublic {
  const projectId = String(row.id || row.project_id || '');
  const explicit = !!row.agent_profile_project_id;
  const projectName = String(row.name || 'AI 직원');
  const projectDescription = nullableText(row.description);
  return {
    id: `project:${projectId}`,
    kind: 'primary',
    projectId,
    displayName: explicit ? (nullableText(row.agent_display_name) || projectName) : projectName,
    face: explicit ? (nullableText(row.agent_face) || '✨') : '✨',
    tagline: explicit ? nullableText(row.agent_tagline) : projectDescription,
    role: explicit ? nullableText(row.agent_role) : projectDescription,
    promise: explicit ? nullableText(row.agent_promise) : null,
    profileVersion: explicit && Number.isFinite(Number(row.agent_instruction_version))
      ? Number(row.agent_instruction_version)
      : 0,
    instructionSource: explicit ? (nullableText(row.agent_instruction_source) || 'agents-md') : 'agents-md',
    defaultEngine: explicit ? nullableText(row.agent_default_engine) : null,
    defaultModel: explicit ? nullableText(row.agent_default_model) : null,
    authorityPolicy: explicit ? record(row.agent_authority_policy) : {},
    toolPolicy: explicit ? record(row.agent_tool_policy) : {},
    memoryPolicy: explicit ? record(row.agent_memory_policy) : {},
    budgetPolicy: explicit ? record(row.agent_budget_policy) : {},
    status: explicit ? (nullableText(row.agent_status) || 'active') : 'active',
    onboardingState: explicit ? (nullableText(row.agent_onboarding_state) || 'ready') : 'implicit',
    careerLevel: (['intern','practitioner','manager','partner'].includes(row.agent_career_level) ? row.agent_career_level : 'intern'),
    explicit,
  };
}

function buildCareerOperatingPolicy(level: ProjectAgentProfilePublic['careerLevel']): string {
  if (level !== 'intern') return '';
  return [
    '## Career Operating Policy: Intern',
    '',
    'You are an intern. Favor learning why the organization does the work, improving useful Project scaffolding, gathering foundational materials, establishing repeatable work processes, and leaving durable records that make later work better. Apply this with judgment rather than as a rigid ceremony.',
    '',
    '### Start with a question',
    '- Usually begin a new or materially unclear assignment with one useful question, including when a direct command leaves its purpose or success criteria unclear.',
    '- Prefer questions about the reason for the assignment, the larger mission, intended user, success evidence, prior attempts, constraints, and where the result will be reused.',
    '- Do not ask ceremonially or repeat context already available. If the purpose and constraints are already clear, proceed and learn through the work.',
    '- If an urgent safety, recovery, or time-critical action must happen first, stabilize it and then ask the question at the earliest safe point.',
    '',
    '### Build the work foundation',
    '- Inspect the existing Project before inventing a new structure. Identify missing or stale instructions, source folders, records, decisions, templates, checklists, indexes, and ownership notes.',
    '- Improve useful scaffolding when it will help this or repeated work. Keep it proportional and do not delay a small task or create empty bureaucracy.',
    '- Gather and organize the foundational source material needed to understand the domain. Preserve source, date, provenance, and uncertainty so later teammates can verify it.',
    '- Turn repeated or newly discovered work into a simple documented process with inputs, steps, decision points, outputs, verification, and escalation conditions.',
    '',
    '### Learn and record',
    '- Leave durable records for meaningful work: confirmed context, user decisions and rationale, source evidence, assumptions, unresolved questions, process improvements, and reusable lessons.',
    '- Separate observations from interpretations. Mark uncertain claims instead of presenting them as established facts.',
    '- Prefer updating the Project canonical document or existing record over creating duplicate notes. Do not record secrets or private data outside their authorized store.',
    '- At completion, report both the requested result and what foundation was improved: scaffolding completed, materials gathered, process established, and records left.',
  ].join('\n');
}

export function buildProjectAgentRuntimePrompt(profile: ProjectAgentRuntimeProfile | null): string {
  if (!profile?.explicit || profile.status !== 'active' && profile.status !== 'ready') return '';
  const careerPolicy = buildCareerOperatingPolicy(profile.careerLevel);
  const lines = [
    '## Project Primary Agent',
    '',
    `You are **${profile.face} ${profile.displayName}**, the Primary Agent for this Project.`,
    profile.tagline ? `Tagline: ${profile.tagline}` : '',
    profile.role ? `Role: ${profile.role}` : '',
    profile.promise ? `Promise: ${profile.promise}` : '',
    `Profile version: ${profile.profileVersion} · source: ${profile.instructionSource}`,
    '',
    profile.instruction || '',
    '',
    careerPolicy,
    '',
    'This DB profile defines the current Primary Agent identity. Project AGENTS.md remains the canonical project operating context and may add more specific rules. The career operating policy describes the default working posture for the current level; apply it with the user’s explicit direction, the task context, and platform safety rules. `.tower/agents/` entries are Helper Agents, not your identity.',
  ];
  return lines.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')).join('\n');
}

/** Return skill names explicitly disabled for this Primary Agent profile. */
export function getDisabledSkillsForAgentProfile(profile: ProjectAgentRuntimeProfile | null): Set<string> {
  const raw = profile?.toolPolicy?.disabledSkills;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean));
}

function runtimeSnapshot(profile: ProjectAgentRuntimeProfile): Record<string, unknown> {
  return {
    id: profile.id,
    kind: profile.kind,
    projectId: profile.projectId,
    displayName: profile.displayName,
    face: profile.face,
    tagline: profile.tagline,
    role: profile.role,
    promise: profile.promise,
    profileVersion: profile.profileVersion,
    instructionSource: profile.instructionSource,
    instruction: profile.instruction,
    status: profile.status,
    onboardingState: profile.onboardingState,
    careerLevel: profile.careerLevel,
    toolPolicy: profile.toolPolicy,
    explicit: profile.explicit,
  };
}

function profileFromSnapshot(value: unknown): ProjectAgentRuntimeProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.kind !== 'primary' || snapshot.explicit !== true) return null;
  return {
    id: String(snapshot.id || ''),
    kind: 'primary',
    projectId: String(snapshot.projectId || ''),
    displayName: String(snapshot.displayName || 'AI 직원'),
    face: String(snapshot.face || '✨'),
    tagline: nullableText(snapshot.tagline),
    role: nullableText(snapshot.role),
    promise: nullableText(snapshot.promise),
    profileVersion: Number(snapshot.profileVersion || 0),
    instructionSource: String(snapshot.instructionSource || 'session-snapshot'),
    instruction: nullableText(snapshot.instruction),
    defaultEngine: null,
    defaultModel: null,
    authorityPolicy: {},
    toolPolicy: record(snapshot.toolPolicy),
    memoryPolicy: {},
    budgetPolicy: {},
    status: String(snapshot.status || 'active'),
    onboardingState: String(snapshot.onboardingState || 'ready'),
    careerLevel: (['intern','practitioner','manager','partner'].includes(String(snapshot.careerLevel)) ? snapshot.careerLevel : 'intern') as ProjectAgentProfilePublic['careerLevel'],
    explicit: true,
  };
}

export async function getProjectAgentRuntimeProfile(projectId: string): Promise<ProjectAgentRuntimeProfile | null> {
  const row = await queryOne<any>(
    `SELECT p.id, p.name, p.description,
            pap.project_id AS agent_profile_project_id,
            pap.display_name AS agent_display_name,
            pap.face AS agent_face,
            pap.tagline AS agent_tagline,
            pap.role AS agent_role,
            pap.promise AS agent_promise,
            pap.instruction AS agent_instruction,
            pap.instruction_version AS agent_instruction_version,
            pap.instruction_source AS agent_instruction_source,
            pap.default_engine AS agent_default_engine,
            pap.default_model AS agent_default_model,
            pap.authority_policy AS agent_authority_policy,
            pap.tool_policy AS agent_tool_policy,
            pap.memory_policy AS agent_memory_policy,
            pap.budget_policy AS agent_budget_policy,
            pap.status AS agent_status,
            pap.onboarding_state AS agent_onboarding_state,
            pap.career_level AS agent_career_level
       FROM projects p
       LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
      WHERE p.id = $1`,
    [projectId],
  );
  if (!row) return null;
  return { ...projectAgentProfileFromRow(row), instruction: nullableText(row.agent_instruction) };
}

/** Resolve the immutable profile snapshot for a Session, pinning lazily for legacy sessions. */
export async function getSessionProjectAgentRuntimeProfile(sessionId: string, projectId: string): Promise<ProjectAgentRuntimeProfile | null> {
  const session = await queryOne<any>(
    `SELECT project_agent_profile_snapshot FROM sessions WHERE id = $1 AND project_id = $2`,
    [sessionId, projectId],
  );
  const pinned = profileFromSnapshot(session?.project_agent_profile_snapshot);
  if (pinned) return pinned;

  const latest = await getProjectAgentRuntimeProfile(projectId);
  if (!latest?.explicit) return null;
  const snapshot = runtimeSnapshot(latest);
  await execute(
    `UPDATE sessions
        SET project_agent_profile_version = $2,
            project_agent_profile_snapshot = $3::jsonb,
            project_agent_profile_source = $4,
            project_agent_profile_pinned_at = NOW()
      WHERE id = $1 AND project_id = $5 AND project_agent_profile_snapshot IS NULL`,
    [sessionId, latest.profileVersion, JSON.stringify(snapshot), latest.instructionSource, projectId],
  );
  const winner = await queryOne<any>('SELECT project_agent_profile_snapshot FROM sessions WHERE id = $1', [sessionId]);
  return profileFromSnapshot(winner?.project_agent_profile_snapshot) || latest;
}

/** Explicitly move one Session to the Project's latest Primary Agent profile. */
export async function repinSessionProjectAgentProfile(sessionId: string, projectId: string): Promise<ProjectAgentRuntimeProfile | null> {
  const latest = await getProjectAgentRuntimeProfile(projectId);
  if (!latest?.explicit) return null;
  await execute(
    `UPDATE sessions
        SET project_agent_profile_version = $2,
            project_agent_profile_snapshot = $3::jsonb,
            project_agent_profile_source = $4,
            project_agent_profile_pinned_at = NOW()
      WHERE id = $1 AND project_id = $5`,
    [sessionId, latest.profileVersion, JSON.stringify(runtimeSnapshot(latest)), latest.instructionSource, projectId],
  );
  return latest;
}

export const PROJECT_AGENT_PROFILE_SELECT = `
  pap.project_id AS agent_profile_project_id,
  pap.display_name AS agent_display_name,
  pap.face AS agent_face,
  pap.tagline AS agent_tagline,
  pap.role AS agent_role,
  pap.promise AS agent_promise,
  pap.instruction_version AS agent_instruction_version,
  pap.instruction_source AS agent_instruction_source,
  pap.default_engine AS agent_default_engine,
  pap.default_model AS agent_default_model,
  pap.authority_policy AS agent_authority_policy,
  pap.tool_policy AS agent_tool_policy,
  pap.memory_policy AS agent_memory_policy,
  pap.budget_policy AS agent_budget_policy,
  pap.status AS agent_status,
  pap.onboarding_state AS agent_onboarding_state,
  pap.career_level AS agent_career_level
`;
