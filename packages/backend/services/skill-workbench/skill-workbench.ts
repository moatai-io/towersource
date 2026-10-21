/**
 * Owns: full-VM-only Beta skill comparison runs.
 * Public API: isSkillWorkbenchEnabled, buildSkillWorkbenchPrompt, runSkillWorkbenchComparison,
 *             listSkillWorkbenchHistory, list/save/delete Skill Workbench test cases.
 * See README.md.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config, getModelDefaults } from '../../config.js';
import { getSkillByName } from '../skill/skill-registry.js';
import { runUtilityTextTask } from '../ai/utility-agent.js';

const MAX_PROMPT_CHARS = 12_000;
const MAX_SKILL_CHARS = 24_000;
const RUN_TIMEOUT_MS = 90_000;
const MAX_HISTORY_ITEMS = 100;
const STORE_DIR = path.join(config.dataDir, 'skill-workbench');
const HISTORY_PATH = path.join(STORE_DIR, 'history.json');
const TEST_CASES_PATH = path.join(STORE_DIR, 'test-cases.json');
const SYSTEM_PROMPT_BASE = `You are running an internal Tower Beta skill workbench comparison.
Return only the answer you would give to the user's prompt.
Do not mention that this is a benchmark unless the user's prompt asks for that.`;

export type SkillWorkbenchRunId = 'skill-off' | 'draft' | 'baseline';

export interface SkillWorkbenchRunRequest {
  projectId?: string | null;
  projectRoot?: string | null;
  prompt: string;
  draftSkillName?: string | null;
  baselineSkillName?: string | null;
  userId?: number;
  username?: string | null;
  saveToHistory?: boolean;
  testCaseId?: string | null;
}

export interface SkillWorkbenchScore {
  total: number;
  rubric: Array<{ id: string; label: string; score: number; note: string }>;
}

export interface SkillWorkbenchRunResult {
  id: SkillWorkbenchRunId;
  label: string;
  skillName?: string;
  output: string;
  elapsedMs: number;
  score: SkillWorkbenchScore;
  error?: string;
}

export interface SkillWorkbenchComparisonResult {
  id: string;
  createdAt: string;
  projectId?: string | null;
  prompt: string;
  draftSkillName?: string | null;
  baselineSkillName?: string | null;
  winnerId?: SkillWorkbenchRunId | null;
  runs: SkillWorkbenchRunResult[];
  testCaseId?: string | null;
  ownerUserId?: number | null;
}

export interface SkillWorkbenchTestCase {
  id: string;
  title: string;
  prompt: string;
  projectId?: string | null;
  draftSkillName?: string | null;
  baselineSkillName?: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  ownerUserId?: number | null;
}

interface BuildPromptInput {
  prompt: string;
  skillName?: string | null;
  skillContent?: string | null;
}

/** Remains private unless a Moat internal full VM explicitly opts in. */
export function isSkillWorkbenchEnabled(): boolean {
  return config.towerRole === 'full' && process.env.SKILL_WORKBENCH_ENABLED === 'true';
}

function ensureStoreDir(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function readJsonArray<T>(filePath: string): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function writeJsonArray<T>(filePath: string, rows: T[]): void {
  ensureStoreDir();
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2) + '\n', 'utf-8');
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated: ${value.length - maxChars} chars omitted]`;
}

function normalizePrompt(prompt: string): string {
  return truncateText(prompt.trim(), MAX_PROMPT_CHARS);
}

/** Builds a stateless utility prompt for one comparison arm. */
export function buildSkillWorkbenchPrompt(input: BuildPromptInput): { prompt: string; systemPrompt: string } {
  const prompt = normalizePrompt(input.prompt);
  const skillName = input.skillName?.trim();
  const skillContent = input.skillContent?.trim();

  if (!skillName || !skillContent) {
    return {
      prompt,
      systemPrompt: `${SYSTEM_PROMPT_BASE}\n\nNo Tower skill instructions are applied for this arm.`,
    };
  }

  const boundedSkill = truncateText(skillContent, MAX_SKILL_CHARS);
  return {
    prompt,
    systemPrompt: `${SYSTEM_PROMPT_BASE}\n\nApply the following Tower skill instructions for this arm.\n\n<skill name="${skillName}">\n${boundedSkill}\n</skill>`,
  };
}

function countMatches(text: string, regex: RegExp): number {
  return text.match(regex)?.length ?? 0;
}

/** Deterministic first-pass score for quickly triaging workbench arms. */
export function scoreSkillWorkbenchOutput(output: string, error?: string): SkillWorkbenchScore {
  if (error) {
    return { total: 0, rubric: [{ id: 'error', label: 'Run health', score: 0, note: error }] };
  }
  const trimmed = output.trim();
  if (!trimmed) {
    return { total: 0, rubric: [{ id: 'empty', label: 'Completeness', score: 0, note: 'No output.' }] };
  }

  const wordish = trimmed.split(/\s+/).filter(Boolean).length;
  const bullets = countMatches(trimmed, /^\s*[-*•]|^\s*\d+[.)]/gm);
  const concrete = countMatches(trimmed, /\d|%|₩|원|일|주|월|고객|사용자|사례|예시|근거|다음|리스크|비용|효과/gi);
  const caveats = countMatches(trimmed, /주의|리스크|한계|가정|다만|but|risk|assumption/gi);
  const action = countMatches(trimmed, /해야|하세요|추천|제안|다음|실행|확인|정리|만들|추가|개선/gi);

  const completeness = Math.min(25, Math.round(wordish / 6));
  const structure = Math.min(20, bullets * 4 + (trimmed.includes('\n\n') ? 4 : 0));
  const specificity = Math.min(25, concrete * 3);
  const judgment = Math.min(15, caveats * 5);
  const actionability = Math.min(15, action * 3);
  const total = Math.min(100, completeness + structure + specificity + judgment + actionability);

  return {
    total,
    rubric: [
      { id: 'completeness', label: 'Completeness', score: completeness, note: `${wordish} word-like tokens.` },
      { id: 'structure', label: 'Structure', score: structure, note: `${bullets} list markers detected.` },
      { id: 'specificity', label: 'Specificity', score: specificity, note: `${concrete} concrete/detail signals.` },
      { id: 'judgment', label: 'Judgment', score: judgment, note: `${caveats} caveat/risk signals.` },
      { id: 'actionability', label: 'Actionability', score: actionability, note: `${action} action signals.` },
    ],
  };
}

function pickWinner(runs: SkillWorkbenchRunResult[]): SkillWorkbenchRunId | null {
  const valid = runs.filter((run) => !run.error && run.output.trim());
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => b.score.total - a.score.total || a.elapsedMs - b.elapsedMs);
  return sorted[0]?.id ?? null;
}

async function resolveSkillContent(input: SkillWorkbenchRunRequest, skillName?: string | null): Promise<string | null> {
  const name = skillName?.trim();
  if (!name) return null;
  const skill = await getSkillByName(
    name,
    input.userId,
    input.projectId ?? null,
    input.username ?? null,
    input.projectRoot ?? undefined,
  );
  return skill?.content ?? null;
}

async function runArm(input: {
  id: SkillWorkbenchRunId;
  label: string;
  prompt: string;
  skillName?: string | null;
  skillContent?: string | null;
  model: string;
}): Promise<SkillWorkbenchRunResult> {
  const started = Date.now();
  try {
    const built = buildSkillWorkbenchPrompt(input);
    const output = await runUtilityTextTask({
      ...built,
      model: input.model,
      fallbackText: '[skill workbench run failed or timed out]',
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const error = output === '[skill workbench run failed or timed out]' ? 'Run failed or timed out' : undefined;
    return {
      id: input.id,
      label: input.label,
      ...(input.skillName ? { skillName: input.skillName } : {}),
      output,
      elapsedMs: Date.now() - started,
      score: scoreSkillWorkbenchOutput(output, error),
      ...(error ? { error } : {}),
    };
  } catch (err: any) {
    const error = err?.message || String(err);
    return {
      id: input.id,
      label: input.label,
      ...(input.skillName ? { skillName: input.skillName } : {}),
      output: '',
      elapsedMs: Date.now() - started,
      score: scoreSkillWorkbenchOutput('', error),
      error,
    };
  }
}

export function listSkillWorkbenchHistory(limit = 30, userId?: number | null): SkillWorkbenchComparisonResult[] {
  return visibleToUser(readJsonArray<SkillWorkbenchComparisonResult>(HISTORY_PATH), userId)
    .slice(0, Math.max(1, Math.min(limit, MAX_HISTORY_ITEMS)));
}

function appendHistory(item: SkillWorkbenchComparisonResult): void {
  const rows = [item, ...readJsonArray<SkillWorkbenchComparisonResult>(HISTORY_PATH)].slice(0, MAX_HISTORY_ITEMS);
  writeJsonArray(HISTORY_PATH, rows);
}

function visibleToUser<T extends { ownerUserId?: number | null }>(rows: T[], userId?: number | null): T[] {
  if (!userId) return rows;
  // Older rows did not have ownerUserId; keep them visible on the internal VM
  // instead of orphaning dogfood history during the Beta transition.
  return rows.filter((row) => !row.ownerUserId || row.ownerUserId === userId);
}

export function listSkillWorkbenchTestCases(userId?: number | null): SkillWorkbenchTestCase[] {
  return visibleToUser(readJsonArray<SkillWorkbenchTestCase>(TEST_CASES_PATH), userId);
}

export function saveSkillWorkbenchTestCase(input: {
  id?: string | null;
  title?: string | null;
  prompt: string;
  projectId?: string | null;
  draftSkillName?: string | null;
  baselineSkillName?: string | null;
  notes?: string | null;
  ownerUserId?: number | null;
}): SkillWorkbenchTestCase {
  if (!input.prompt?.trim()) throw new Error('prompt is required');
  const now = new Date().toISOString();
  const rows = readJsonArray<SkillWorkbenchTestCase>(TEST_CASES_PATH);
  const existingIndex = input.id ? rows.findIndex((row) => row.id === input.id && (!input.ownerUserId || !row.ownerUserId || row.ownerUserId === input.ownerUserId)) : -1;
  const title = input.title?.trim() || input.prompt.trim().slice(0, 80);
  const next: SkillWorkbenchTestCase = {
    id: existingIndex >= 0 ? rows[existingIndex].id : uuidv4(),
    title,
    prompt: input.prompt.trim(),
    projectId: input.projectId ?? null,
    draftSkillName: input.draftSkillName?.trim() || null,
    baselineSkillName: input.baselineSkillName?.trim() || null,
    notes: input.notes?.trim() || '',
    createdAt: existingIndex >= 0 ? rows[existingIndex].createdAt : now,
    updatedAt: now,
    ownerUserId: existingIndex >= 0 ? (rows[existingIndex].ownerUserId ?? input.ownerUserId ?? null) : (input.ownerUserId ?? null),
  };
  if (existingIndex >= 0) rows[existingIndex] = next;
  else rows.unshift(next);
  writeJsonArray(TEST_CASES_PATH, rows);
  return next;
}

export function deleteSkillWorkbenchTestCase(id: string, userId?: number | null): boolean {
  const rows = readJsonArray<SkillWorkbenchTestCase>(TEST_CASES_PATH);
  const target = rows.find((row) => row.id === id);
  if (!target) return false;
  if (userId && target.ownerUserId && target.ownerUserId !== userId) return false;
  const next = rows.filter((row) => row.id !== id);
  writeJsonArray(TEST_CASES_PATH, next);
  return true;
}

/** Runs Skill off / Draft skill / Baseline skill as isolated stateless utility calls. */
export async function runSkillWorkbenchComparison(input: SkillWorkbenchRunRequest): Promise<SkillWorkbenchComparisonResult> {
  if (!isSkillWorkbenchEnabled()) {
    throw new Error('Skill workbench is disabled on this VM');
  }
  if (!input.prompt?.trim()) {
    throw new Error('prompt is required');
  }

  const model = getModelDefaults().session;
  const [draftContent, baselineContent] = await Promise.all([
    resolveSkillContent(input, input.draftSkillName),
    resolveSkillContent(input, input.baselineSkillName),
  ]);

  const runs = await Promise.all([
    runArm({ id: 'skill-off', label: 'Skill off', prompt: input.prompt, model }),
    runArm({ id: 'draft', label: 'Draft skill', prompt: input.prompt, skillName: input.draftSkillName ?? undefined, skillContent: draftContent, model }),
    runArm({ id: 'baseline', label: 'Baseline skill', prompt: input.prompt, skillName: input.baselineSkillName ?? undefined, skillContent: baselineContent, model }),
  ]);

  if (input.draftSkillName && !draftContent) {
    runs[1] = { ...runs[1], error: `Skill not found or inactive: ${input.draftSkillName}`, score: scoreSkillWorkbenchOutput(runs[1].output, `Skill not found or inactive: ${input.draftSkillName}`) };
  }
  if (input.baselineSkillName && !baselineContent) {
    runs[2] = { ...runs[2], error: `Skill not found or inactive: ${input.baselineSkillName}`, score: scoreSkillWorkbenchOutput(runs[2].output, `Skill not found or inactive: ${input.baselineSkillName}`) };
  }

  const result: SkillWorkbenchComparisonResult = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    projectId: input.projectId ?? null,
    prompt: input.prompt.trim(),
    draftSkillName: input.draftSkillName?.trim() || null,
    baselineSkillName: input.baselineSkillName?.trim() || null,
    winnerId: pickWinner(runs),
    runs,
    testCaseId: input.testCaseId ?? null,
    ownerUserId: input.userId ?? null,
  };
  if (input.saveToHistory !== false) appendHistory(result);
  return result;
}
