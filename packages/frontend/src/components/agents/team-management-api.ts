/** Narrow transport for the server-issued team approval contract. No unrelated directory queries. */
export interface ManagedTeam { id: string; name: string; state: string; version: number }
export type TeamCommand =
  | { kind: 'create'; teamId: string; name: string }
  | { kind: 'invite' | 'revoke'; teamId: string; userId: number }
  | { kind: 'assign'; teamId: string; projectId: string };
export interface TeamDetail {
  team: ManagedTeam;
  members: { userId: number; state: string; role: string }[];
  agents: { projectId: string }[];
}
export interface TeamIntent {
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  preview: {
    actorUserId: number;
    command: TeamCommand;
    expected: { teamVersion: number | null; teamState: string | null; memberState: string | null; assignedTeamId: string | null; workspaceIds: string[] };
    warnings: string[];
  };
  impact?: { eligibleAgentCount: number | null; registeredWorkspaceCount: number | null; affectedOwnSessionCount: number | null; note: string; warning: string };
}
export class TeamApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const invalid = () => new TeamApiError(0, 'TEAM_MANAGEMENT_RESPONSE_INVALID');
async function request(path: string, signal: AbortSignal, body?: unknown): Promise<any> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/agent-teams${path}`, { method: body === undefined ? 'GET' : 'POST', headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new TeamApiError(response.status, typeof payload?.error === 'string' ? payload.error : 'TEAM_MANAGEMENT_UNAVAILABLE');
  }
  return response.json().catch(() => { throw invalid(); });
}
function isTeam(value: any): value is ManagedTeam {
  return !!value && typeof value.id === 'string' && !!value.id.trim() && typeof value.name === 'string'
    && ['active', 'disabled'].includes(value.state) && Number.isSafeInteger(value.version) && value.version > 0;
}
export async function listManagedTeams(signal: AbortSignal): Promise<ManagedTeam[]> {
  const data = await request('', signal);
  if (!Array.isArray(data?.teams) || !data.teams.every(isTeam)) throw invalid();
  return data.teams;
}
export async function getManagedTeam(teamId: string, signal: AbortSignal): Promise<TeamDetail> {
  const data = await request(`/${encodeURIComponent(teamId)}`, signal);
  if (!isTeam(data?.team) || data.team.id !== teamId || !Array.isArray(data.members) || !Array.isArray(data.agents)
    || !data.members.every((member: any) => Number.isSafeInteger(member?.userId) && member.userId > 0 && ['active', 'disabled'].includes(member.state) && typeof member.role === 'string')
    || !data.agents.every((agent: any) => typeof agent?.projectId === 'string')) throw invalid();
  return data;
}
export async function previewTeamCommand(command: TeamCommand, signal: AbortSignal): Promise<TeamIntent> {
  const data = await request('/preview', signal, command);
  const preview = data?.preview;
  const expected = preview?.expected;
  const returnedCommand = preview?.command;
  const sameCommand = returnedCommand && returnedCommand.kind === command.kind && returnedCommand.teamId === command.teamId
    && (command.kind === 'create' ? returnedCommand.name === command.name : command.kind === 'assign' ? returnedCommand.projectId === command.projectId : returnedCommand.userId === command.userId);
  if (typeof data?.intentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(data.intentId)
    || typeof data.proposalHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.proposalHash)
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
    || !Number.isSafeInteger(preview?.actorUserId) || !sameCommand || !expected
    || !(expected.teamVersion === null || (Number.isSafeInteger(expected.teamVersion) && expected.teamVersion > 0))
    || ![expected.teamState, expected.memberState].every(value => value === null || ['active', 'disabled'].includes(value))
    || !(expected.assignedTeamId === null || typeof expected.assignedTeamId === 'string')
    || !Array.isArray(expected.workspaceIds) || !expected.workspaceIds.every((id: unknown) => typeof id === 'string')
    || !Array.isArray(preview.warnings) || !preview.warnings.every((warning: unknown) => typeof warning === 'string')) throw invalid();
  if (data.impact && (typeof data.impact.note !== 'string' || typeof data.impact.warning !== 'string'
    || !['eligibleAgentCount', 'registeredWorkspaceCount', 'affectedOwnSessionCount'].every(key => data.impact[key] === null || (Number.isSafeInteger(data.impact[key]) && data.impact[key] >= 0)))) throw invalid();
  return data;
}
export async function applyTeamIntent(intent: TeamIntent, signal: AbortSignal): Promise<{ changed: boolean; teamVersion: number }> {
  const data = await request('/apply', signal, { intentId: intent.intentId, proposalHash: intent.proposalHash, confirmed: true });
  if (typeof data?.changed !== 'boolean' || !Number.isSafeInteger(data.teamVersion) || data.teamVersion < 1) throw invalid();
  return data;
}
