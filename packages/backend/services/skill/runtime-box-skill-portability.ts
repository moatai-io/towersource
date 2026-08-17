/**
 * Owns: static portability checks for skills materialized into Project Runtime Boxes.
 * Public API: auditRuntimeBoxSkillBody(). See workspace decision 2026-08-07.
 */

export type RuntimeBoxSkillPortabilityIssueCode =
  | 'host_skill_path'
  | 'host_tower_path'
  | 'host_session_metadata_path'
  | 'host_local_api'
  | 'host_control_plane_cli'
  | 'host_tmp_handoff';

export interface RuntimeBoxSkillPortabilityIssue {
  code: RuntimeBoxSkillPortabilityIssueCode;
  message: string;
}

function executableSkillExamples(body: string): string {
  const blocks = [...body.matchAll(/```(bash|sh|shell|zsh)\s*\n([\s\S]*?)```/g)]
    .map(match => match[2]);
  return blocks.join('\n');
}

/** Find executable examples with host-only assumptions that cannot work in an ordinary Project Runtime Box. */
export function auditRuntimeBoxSkillBody(body: string): RuntimeBoxSkillPortabilityIssue[] {
  const executable = executableSkillExamples(body);
  const checks: Array<[RuntimeBoxSkillPortabilityIssueCode, RegExp, string]> = [
    ['host_skill_path', /(?:~\/\.claude\/skills|\$HOME\/\.claude\/skills|\/home\/[^\s"']+\/\.claude\/skills)/, 'Use /workspace/.tower/skills/<skill> instead of a host-global Claude skill path.'],
    ['host_tower_path', /(?:~\/tower|\$HOME\/tower|\/home\/[^\s"']+\/tower)(?:\/|\b)/, 'Tower source and operator scripts are host-only; use a first-party tool or a materialized Project skill.'],
    ['host_session_metadata_path', /(?:~\/\.claude\/(?:projects|todos|hooks)|\$HOME\/\.claude\/(?:projects|todos|hooks))/, 'Host session metadata is not mounted; use Tower conversation/session tools.'],
    ['host_local_api', /(?:localhost|127\.0\.0\.1):(?:32354|32355|32364)\b/, 'Runtime Box localhost is not the Tower host; use the matching first-party Tower tool.'],
    ['host_control_plane_cli', /(?:^|[;&|`\s])(pm2|systemctl|docker|nix(?:os-rebuild)?|journalctl)\s+/m, 'Host control-plane CLI is unavailable to ordinary Project users.'],
    ['host_tmp_handoff', /(?:^|[\s"'=])\/tmp\/(?:codex|gemini|claude|tower)-[^\s"']+/, 'Do not hand off durable artifacts through host /tmp; keep them under /workspace.'],
  ];
  return checks
    .filter(([, pattern]) => pattern.test(executable))
    .map(([code, , message]) => ({ code, message }));
}
