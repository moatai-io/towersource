/**
 * Owns: Locating teamskills organization skill sources and default skillset metadata.
 * Public API: getTeamskillsProjectRoot, getTeamskillsSkillRoot, readTeamskillsSkillset.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TeamskillsSkillsetFile {
  version?: number;
  defaultSkills?: unknown;
}

export interface TeamskillsSkillsetValidationResult {
  path: string;
  source: 'teamskills' | 'missing';
  skills: string[];
  warnings: string[];
}

/** Return the workspace root used for VM-local teamskills sources. */
export function getWorkspaceRoot(): string {
  return process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'workspace');
}

/** Return the teamskills project root. Tests/operators may override with TEAMSKILLS_PROJECT_ROOT. */
export function getTeamskillsProjectRoot(): string {
  return process.env.TEAMSKILLS_PROJECT_ROOT || path.join(getWorkspaceRoot(), 'projects', 'teamskills');
}

/** Return the canonical organization skill root for a skill name. */
export function getTeamskillsSkillRoot(skillName: string): string {
  return path.join(getTeamskillsProjectRoot(), 'skills', skillName);
}

/** Return true for a safe skill directory name. */
export function isSafeSkillName(skillName: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(skillName);
}

/** Validate and read VM-level default materialized skills from teamskills/skillset.json. */
export function validateTeamskillsSkillset(fallback: readonly string[]): TeamskillsSkillsetValidationResult {
  const skillsetPath = path.join(getTeamskillsProjectRoot(), 'skillset.json');
  let parsed: TeamskillsSkillsetFile | string[];
  try {
    parsed = JSON.parse(fs.readFileSync(skillsetPath, 'utf-8')) as TeamskillsSkillsetFile | string[];
  } catch (err) {
    return {
      path: skillsetPath,
      source: 'missing',
      skills: [...fallback],
      warnings: [`teamskills skillset unavailable; using temporary compiled name-list fallback: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const warnings: string[] = [];
  if (!Array.isArray(parsed)) {
    if (typeof parsed.version !== 'number') warnings.push('version should be a number');
    const keys = new Set(Object.keys(parsed));
    for (const allowed of ['version', 'description', 'defaultSkills', 'notes']) keys.delete(allowed);
    if (keys.size > 0) warnings.push(`unknown top-level keys: ${Array.from(keys).sort().join(', ')}`);
  }

  const rawSkills = Array.isArray(parsed) ? parsed : parsed.defaultSkills;
  if (!Array.isArray(rawSkills)) {
    return {
      path: skillsetPath,
      source: 'missing',
      skills: [...fallback],
      warnings: [...warnings, 'defaultSkills must be an array; using temporary compiled name-list fallback'],
    };
  }

  const seen = new Set<string>();
  const skills: string[] = [];
  rawSkills.forEach((item, index) => {
    const name = parseSkillsetItemName(item);
    if (!name) {
      warnings.push(`defaultSkills[${index}] must be a skill name string or { name } object`);
      return;
    }
    if (!isSafeSkillName(name)) {
      warnings.push(`defaultSkills[${index}] has invalid skill name: ${name}`);
      return;
    }
    if (seen.has(name)) {
      warnings.push(`duplicate skill ignored: ${name}`);
      return;
    }
    seen.add(name);
    skills.push(name);
  });

  if (skills.length === 0) {
    return {
      path: skillsetPath,
      source: 'missing',
      skills: [...fallback],
      warnings: [...warnings, 'defaultSkills contained no valid skill names; using temporary compiled name-list fallback'],
    };
  }

  return { path: skillsetPath, source: 'teamskills', skills, warnings };
}

/** Read VM-level default materialized skill names from teamskills/skillset.json, using compiled names only as a temporary bootstrap fallback. */
export function readTeamskillsSkillset(fallback: readonly string[]): string[] {
  return validateTeamskillsSkillset(fallback).skills;
}

function parseSkillsetItemName(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() || null;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const name = (item as { name?: unknown }).name;
  return typeof name === 'string' ? name.trim() || null : null;
}
