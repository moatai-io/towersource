/**
 * Project Agent Definitions — file-backed reusable subagent roles.
 *
 * Owns: `.tower/agents/*.agent.yaml|json` discovery and validation.
 * Public API: loadProjectAgentDefinitions(), findProjectAgentDefinition().
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { MODEL_POLICY_IDS, type ModelPolicyId } from './model-policy/model-policy.js';
import type { EffortLevel } from '../engines/types.js';

export type AgentDefinitionVisibility = 'background' | 'sidebar' | 'team' | 'system';

export interface AgentDefinition {
  id: string;
  displayName?: string;
  face?: string;
  tagline?: string;
  role: string;
  instruction: string;
  goal?: string;
  engine?: 'pi' | 'claude';
  model?: string;
  modelPolicy?: ModelPolicyId;
  effort?: EffortLevel;
  visibility?: AgentDefinitionVisibility;
  permissions?: Record<string, unknown>;
  report?: Record<string, unknown>;
  sourcePath: string;
}

export interface AgentDefinitionPublic {
  id: string;
  displayName?: string;
  face?: string;
  tagline?: string;
  role: string;
  instruction: string;
  goal?: string;
  engine?: 'pi' | 'claude';
  model?: string;
  modelPolicy?: ModelPolicyId;
  effort?: EffortLevel;
  visibility: AgentDefinitionVisibility;
  permissions?: Record<string, unknown>;
  report?: Record<string, unknown>;
  sourcePath: string;
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isAgentDefinitionFile(fileName: string): boolean {
  return /\.agent\.(json|ya?ml)$/i.test(fileName);
}

function parseAgentDefinitionFile(filePath: string): any {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.json' ? JSON.parse(raw) : YAML.parse(raw);
}

function normalizeVisibility(value: unknown): AgentDefinitionVisibility {
  return value === 'sidebar' || value === 'team' || value === 'system' || value === 'background'
    ? value
    : 'background';
}

function normalizeEngine(value: unknown): 'pi' | 'claude' | undefined {
  return value === 'pi' || value === 'claude' ? value : undefined;
}

function normalizeModelPolicy(value: unknown): ModelPolicyId | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && MODEL_POLICY_IDS.includes(value as ModelPolicyId)) return value as ModelPolicyId;
  throw new Error(`unsupported modelPolicy ${String(value)}`);
}

function normalizeEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
  throw new Error(`unsupported effort ${String(value)}`);
}

export function normalizeAgentDefinition(input: any, sourcePath: string): AgentDefinitionPublic {
  if (!input || typeof input !== 'object') {
    throw new Error('agent definition must be an object');
  }
  const id = String(input.id || '').trim();
  if (!AGENT_ID_RE.test(id)) {
    throw new Error('agent definition id must use lowercase letters, numbers, and hyphens');
  }
  const role = String(input.role || '').trim();
  if (!role) throw new Error(`agent definition ${id} must include role`);
  const instruction = String(input.instruction || '').trim();
  if (!instruction) throw new Error(`agent definition ${id} must include instruction`);

  const displayName = typeof input.displayName === 'string'
    ? input.displayName.trim() || undefined
    : typeof input.display_name === 'string'
      ? input.display_name.trim() || undefined
      : undefined;

  return {
    id,
    displayName,
    face: typeof input.face === 'string' ? input.face.trim() || undefined : undefined,
    tagline: typeof input.tagline === 'string' ? input.tagline.trim() || undefined : undefined,
    role,
    instruction,
    goal: typeof input.goal === 'string' ? input.goal.trim() || undefined : undefined,
    engine: normalizeEngine(input.engine),
    model: typeof input.model === 'string' ? input.model.trim() || undefined : undefined,
    modelPolicy: normalizeModelPolicy(input.modelPolicy ?? input.model_policy),
    effort: normalizeEffort(input.effort),
    visibility: normalizeVisibility(input.visibility),
    permissions: input.permissions && typeof input.permissions === 'object' ? input.permissions : undefined,
    report: input.report && typeof input.report === 'object' ? input.report : undefined,
    sourcePath,
  };
}

export function loadProjectAgentDefinitions(projectRoot?: string | null): AgentDefinitionPublic[] {
  if (!projectRoot) return [];
  const agentsDir = path.join(projectRoot, '.tower', 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  const files = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((item) => item.isFile() && isAgentDefinitionFile(item.name))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b));

  const definitions: AgentDefinitionPublic[] = [];
  for (const fileName of files) {
    const filePath = path.join(agentsDir, fileName);
    try {
      definitions.push(normalizeAgentDefinition(parseAgentDefinitionFile(filePath), filePath));
    } catch (err: any) {
      console.warn(`[agents] skipping invalid agent definition ${filePath}: ${err?.message || err}`);
    }
  }
  return definitions;
}

export function findProjectAgentDefinition(projectRoot: string | null | undefined, idOrName: string): AgentDefinitionPublic | null {
  const needle = String(idOrName || '').trim().toLocaleLowerCase();
  if (!needle) return null;
  return loadProjectAgentDefinitions(projectRoot).find((definition) => (
    definition.id.toLocaleLowerCase() === needle ||
    definition.displayName?.toLocaleLowerCase() === needle
  )) || null;
}

function definitionPath(projectRoot: string, id: string): string {
  if (!AGENT_ID_RE.test(id)) {
    throw new Error('agent definition id must use lowercase letters, numbers, and hyphens');
  }
  return path.join(projectRoot, '.tower', 'agents', `${id}.agent.yaml`);
}

function serializeAgentDefinition(definition: AgentDefinitionPublic): string {
  const data: Record<string, unknown> = {
    id: definition.id,
    displayName: definition.displayName,
    face: definition.face,
    tagline: definition.tagline,
    role: definition.role,
    instruction: definition.instruction,
    goal: definition.goal,
    engine: definition.engine,
    model: definition.model,
    modelPolicy: definition.modelPolicy,
    effort: definition.effort,
    visibility: definition.visibility,
    permissions: definition.permissions,
    report: definition.report,
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined || data[key] === '') delete data[key];
  }
  return YAML.stringify(data, { lineWidth: 0 });
}

export function saveProjectAgentDefinition(projectRoot: string, input: unknown, opts?: { overwrite?: boolean; existingId?: string }): AgentDefinitionPublic {
  const normalized = normalizeAgentDefinition(input, '');
  const agentsDir = path.join(projectRoot, '.tower', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const existingId = opts?.existingId?.trim();
  const targetPath = definitionPath(projectRoot, normalized.id);
  if (existingId && existingId !== normalized.id) {
    const oldPath = definitionPath(projectRoot, existingId);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  if (!opts?.overwrite && fs.existsSync(targetPath)) {
    throw Object.assign(new Error(`agent definition ${normalized.id} already exists`), { code: 'AGENT_EXISTS' });
  }

  const saved = { ...normalized, sourcePath: targetPath };
  fs.writeFileSync(targetPath, serializeAgentDefinition(saved), 'utf8');
  return saved;
}
