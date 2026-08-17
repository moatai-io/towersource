/**
 * Owns: one-off/safe reconciliation of legacy default project AGENTS.md files.
 * Public API: classifyAgentsMd, reconcileProjectAgentsMd. See AGENTS.md for project instruction conventions.
 */
import fs from 'fs';
import path from 'path';
import { renderProjectAgentsMd } from '../services/pm/project-manager.js';

const DEFAULT_DESCRIPTION = '이 프로젝트는 아직 목적이 충분히 설명되지 않았습니다. 작업하면서 README/AGENTS를 채워갑니다.';
const CURRENT_MARKER = '<!-- tower-default-agents-template:v2 -->';
const LEGACY_ANCHORS = [
  '## First Contact', '## Early Project Formation', '## Working Rhythm',
  '## Records', '## Knowledge Updates', '## Long-Term Interaction',
  '자세한 배경, 긴 요약, 여러 자료의 종합은 `.wiki/`에 점진적으로 컴파일한다.',
];
const LEGACY_FIXED_LINES = new Set([
  '이 `AGENTS.md`는 에이전트가 사용자를 처음 만나는 순간부터 장기적으로 협업하는 방식까지 정하는 짧은 운영 지침이다.',
  '목표는 모든 것을 미리 정하는 것이 아니라, 초기 대화에서 프로젝트의 방향을 감지하고 중요한 결정과 반복 패턴을 조금씩 기록으로 승격하는 것이다.',
]);

export type ReconcileClassification = 'current' | 'legacy-default' | 'customized' | 'missing';
export interface ReconcileResult {
  projectDir: string; agentsPath: string; classification: ReconcileClassification;
  action: 'unchanged' | 'would-replace' | 'replaced' | 'skipped'; reason: string;
}

/** Classifies AGENTS.md content so only the exact known legacy default is replaceable. */
export function classifyAgentsMd(contents: string | undefined): ReconcileClassification {
  if (contents === undefined) return 'missing';
  if (contents.includes(CURRENT_MARKER)) return 'current';
  const lines = contents.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => line === '## First Contact');
  const headingCount = lines.filter((line) => /^##\s+/.test(line)).length;
  const hasOneFreeDescriptionBeforeFirstSection = firstSection > 0 && lines.slice(1, firstSection)
    .filter((line) => line.trim() && !LEGACY_FIXED_LINES.has(line)).length === 1;
  if (
    LEGACY_ANCHORS.every((anchor) => contents.includes(anchor))
    && headingCount === 6
    && hasOneFreeDescriptionBeforeFirstSection
    && contents.trimEnd().endsWith('4. 행동 규칙으로 굳어진 것만 `AGENTS.md`에 짧게 반영한다.')
  ) return 'legacy-default';
  return 'customized';
}

function projectTitle(contents: string | undefined, projectDir: string): string {
  return contents?.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(projectDir);
}
function projectDescription(contents: string | undefined): string {
  if (!contents) return DEFAULT_DESCRIPTION;
  const lines = contents.split(/\r?\n/);
  const firstHeading = lines.findIndex((line) => /^#\s+/.test(line));
  for (let i = firstHeading + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('<!--')) continue;
    if (line.startsWith('#')) break;
    if (line.startsWith('이 `AGENTS.md`는')) continue;
    return line;
  }
  return DEFAULT_DESCRIPTION;
}

/** Dry-runs or replaces one legacy default AGENTS.md while preserving customized project instructions. */
export function reconcileProjectAgentsMd(projectDir: string, apply = false): ReconcileResult {
  const agentsPath = path.join(projectDir, 'AGENTS.md');
  const contents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : undefined;
  const classification = classifyAgentsMd(contents);
  if (classification === 'current') return { projectDir, agentsPath, classification, action: 'unchanged', reason: 'current managed template marker present' };
  if (classification !== 'legacy-default') return { projectDir, agentsPath, classification, action: 'skipped', reason: classification === 'missing' ? 'AGENTS.md missing; do not create during reconciliation' : 'customized or unknown content preserved' };
  if (!apply) return { projectDir, agentsPath, classification, action: 'would-replace', reason: 'all known legacy default anchors matched' };

  const next = renderProjectAgentsMd(projectTitle(contents, projectDir), projectDescription(contents));
  const backupPath = `${agentsPath}.bak-before-default-v2`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(agentsPath, backupPath);
  fs.writeFileSync(agentsPath, next, 'utf8');
  return { projectDir, agentsPath, classification, action: 'replaced', reason: `legacy default replaced; backup=${backupPath}` };
}

function parseArgs(argv: string[]): { root: string; apply: boolean } {
  let root = process.env.WORKSPACE_ROOT ? path.join(process.env.WORKSPACE_ROOT, 'projects') : '';
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--root') root = argv[++i] || '';
  }
  if (!root) throw new Error('Pass --root <projects-directory> or set WORKSPACE_ROOT');
  return { root: path.resolve(root), apply };
}
function main(): void {
  const { root, apply } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(root)) throw new Error(`Projects directory not found: ${root}`);
  const results = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => reconcileProjectAgentsMd(path.join(root, entry.name), apply));
  for (const result of results) console.log(JSON.stringify(result));
  const summary = results.reduce<Record<string, number>>((acc, result) => { acc[result.action] = (acc[result.action] || 0) + 1; return acc; }, {});
  console.error(JSON.stringify({ root, mode: apply ? 'apply' : 'dry-run', summary }));
}
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) main();
