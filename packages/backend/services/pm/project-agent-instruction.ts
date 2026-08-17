/**
 * Owns: deterministic materialization of the explicit Primary Agent profile in Project AGENTS.md.
 * Public API: ensureProjectAgentInstruction.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ProjectAgentInstructionProfile {
  displayName?: unknown;
  face?: unknown;
  tagline?: unknown;
  role?: unknown;
  promise?: unknown;
  instruction?: unknown;
}

const START = '<!-- tower-primary-agent-profile -->';
const END = '<!-- /tower-primary-agent-profile -->';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Render the exact managed block written into AGENTS.md. */
export function renderProjectAgentInstruction(profile: ProjectAgentInstructionProfile): string {
  const displayName = text(profile.displayName) || 'AI 직원';
  const face = text(profile.face) || '✨';
  const lines = [
    START,
    '## Primary Agent Profile',
    '',
    `이 프로젝트는 **${face} ${displayName}**라는 하나의 Primary Agent Workcell입니다.`,
    text(profile.tagline) || '',
    '',
    text(profile.promise) ? `약속: ${text(profile.promise)}` : '',
    text(profile.role) ? `역할: ${text(profile.role)}` : '',
    '',
    text(profile.instruction) || '',
    '',
    '이 프로젝트의 모든 일반 세션에서는 위 Primary Agent의 정체성과 행동 양식을 유지합니다.',
    '`.tower/agents/`의 정의는 Primary Agent가 필요할 때 활용하는 Helper Agent입니다.',
    END,
  ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
  return lines.join('\n');
}

/** Ensure one exact managed block exists, replacing stale content and verifying the postcondition. */
export function ensureProjectAgentInstruction(rootPath: string, profile: ProjectAgentInstructionProfile): void {
  if (!rootPath?.trim()) throw new Error('Project root path is required to materialize the Primary Agent profile');
  const agentsPath = path.join(rootPath, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) throw new Error(`Project AGENTS.md not found: ${agentsPath}`);
  const current = fs.readFileSync(agentsPath, 'utf8');
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && (end < start || current.indexOf(START, start + START.length) >= 0 || current.indexOf(END, end + END.length) >= 0))) {
    throw new Error(`Project AGENTS.md has a malformed Primary Agent profile block: ${agentsPath}`);
  }

  const expected = renderProjectAgentInstruction(profile);
  const next = start >= 0
    ? `${current.slice(0, start)}${expected}${current.slice(end + END.length)}`
    : `${current.replace(/\s*$/, '')}\n\n${expected}\n`;
  fs.writeFileSync(agentsPath, next, 'utf8');

  const verified = fs.readFileSync(agentsPath, 'utf8');
  const verifiedStart = verified.indexOf(START);
  const verifiedEnd = verified.indexOf(END);
  const actual = verifiedStart >= 0 && verifiedEnd >= verifiedStart
    ? verified.slice(verifiedStart, verifiedEnd + END.length)
    : '';
  if (actual !== expected || verified.indexOf(START, verifiedStart + START.length) >= 0 || verified.indexOf(END, verifiedEnd + END.length) >= 0) {
    throw new Error(`Project AGENTS.md Primary Agent profile verification failed: ${agentsPath}`);
  }
}
