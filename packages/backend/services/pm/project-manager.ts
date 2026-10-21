import { query, queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { getAccessibleProjectIds, addProjectMember, autoSeedProjectMembers } from './project-membership-manager.js';
import { config, DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS } from '../../config.js';
import { seedProjectDefaultSkills } from './project-default-skills.js';
import { readTeamskillsSkillset } from '../skill/teamskills-source.js';
import { withNewProjectStorage } from './new-project-storage-policy.js';
import { provisionCanonicalProjectWorkspace } from '../project-environment/project-workspace-authority.js';
import { resolveProjectEnvironmentDeploymentId } from '../project-environment/project-environment-deployment.js';
import { ensureProjectAgentInstruction } from './project-agent-instruction.js';
import { INTRODUCTION_INSTRUCTION, seedIntroductionGuides } from './introduction-guide.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/tmp', 'workspace');
const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const RESERVED_SYSTEM_PROJECT_SLUGS = new Set(['teamskills']);

const KOREAN_PROJECT_WORDS: Array<[RegExp, string]> = [
  [/한투|한국투자|한국투자신탁|한국투자신탁운용/gi, 'hantoo'],
  [/오쿠|오케이유|OKU/gi, 'oku'],
  [/타워|Tower/gi, 'tower'],
  [/모트|모트에이아이|MOAT/gi, 'moat'],
  [/리서치|조사/gi, 'research'],
  [/회사소개서|회사 ?소개서/gi, 'company-profile'],
  [/제안서|제안/gi, 'proposal'],
  [/보고서|보고/gi, 'report'],
  [/분석/gi, 'analysis'],
  [/운영/gi, 'ops'],
  [/개발/gi, 'dev'],
  [/디자인/gi, 'design'],
  [/문서/gi, 'docs'],
  [/테스트/gi, 'test'],
  [/실험/gi, 'experiment'],
  [/고객/gi, 'customer'],
  [/내부/gi, 'internal'],
  [/영업/gi, 'sales'],
  [/마케팅/gi, 'marketing'],
  [/재무/gi, 'finance'],
  [/법무/gi, 'legal'],
];

/**
 * Build a human-readable English filesystem slug for project cwd paths.
 *
 * DB `projects.id` remains a stable UUID; this slug is only for
 * `workspace/projects/<slug>` readability. Korean project names commonly used
 * by Tower customers are lightly translated before the ASCII cleanup. Unknown
 * CJK-only names fall back to `project` so creation remains predictable.
 */
export function slugifyProjectName(name: string): string {
  let normalized = name.normalize('NFC');
  for (const [pattern, replacement] of KOREAN_PROJECT_WORDS) {
    normalized = normalized.replace(pattern, ` ${replacement} `);
  }
  return normalized
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/g, '')
    || 'project';
}

export function normalizeProjectSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function isReservedSystemProjectSlug(slug: string): boolean {
  return RESERVED_SYSTEM_PROJECT_SLUGS.has(normalizeProjectSlug(slug));
}

export function assertValidProjectSlug(slug: string): string {
  const normalized = normalizeProjectSlug(slug);
  if (!PROJECT_SLUG_RE.test(normalized)) {
    throw new Error('Project folder slug must use lowercase letters, numbers, and hyphens; start/end with a letter or number; max 80 chars');
  }
  return normalized;
}

/** Pick `base`, `base-2`, `base-3`, ... instead of UUID-looking suffixes. */
export function nextAvailableProjectSlug(baseSlug: string, exists: (slug: string) => boolean): string {
  if (!exists(baseSlug)) return baseSlug;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${baseSlug}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate project slug for ${baseSlug}`);
}

function slugify(name: string): string {
  return slugifyProjectName(name);
}

// ─────────────────────────────────────────────────────────────
// Project scaffolding templates
// ─────────────────────────────────────────────────────────────
// These templates are what agents see when they first read a project.
// They must explicitly describe the visible scaffold — otherwise agents keep
// putting human-facing work into hidden dot-folders or ad-hoc top-level directories.
// 2026-05-11: heartbeat 자동 갱신 흔적 제거 — decisions/2026-04-28-heartbeat-deprecation.md
//   Phase 5-A. progress.md → AGENTS.md 갱신은 이제 사용자 수동 호출 (`/agents-md --evolve`) 만.

function md(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

export function renderProjectAgentsMd(name: string, description: string): string {
  return md([
    `# ${name}`,
    '',
    '<!-- tower-default-agents-template:v2 -->',
    '',
    description,
    '',
    '## 정확한 판단과 안전한 실행',
    '',
    '비개발자도 판단할 수 있는 말로 사실·가정·대안·장단점·추천 이유를 설명합니다. 필요한 정보가 없을 때만 가장 중요한 질문 하나를 묻고 이미 받은 정보는 다시 묻지 않습니다.',
    '자동화 문제에는 전문적이고 친절하게 대응합니다. 원인을 조사하고 권한 안에서 안전하게 복구한 뒤 실제 결과를 검증하며, 확인하지 못한 부분은 명확하게 알립니다.',
    '공통 목적은 initiative, 완료 조건이 있는 업무는 project로 필요할 때만 나눕니다. 작은 업무에 빈 폴더를 강제하지 않고 기존 코드 구조를 유지합니다.',
    '생각·근거·제안 문헌을 저장했다고 승인된 것은 아닙니다. decisions.md와 decisions/에는 채택된 정책과 판단만 기록합니다. 조사 요청만으로 accepted 결정을 만들지 않습니다.',
    'DB 프로필은 현재 승인된 정체성·역할·권한의 정본입니다. character.md는 생성 당시 기대의 참조 기록이며 기존 SOUL.md와 중복 정본을 만들지 않습니다. 초기 가설은 확인된 사실과 분리하고 승인된 역할·권한을 임의로 바꾸지 않습니다.',
    '',
    '## 역할',
    '',
    '당신은 일을 빈틈없이 수행하고 명확하게 소통하는 유능한 비서이자 업무 파트너다.',
    '',
    '사용자의 요청을 처리하는 데서 그치지 않고, 필요한 자료와 진행 맥락을 찾기 쉽게 정리하며 다음 작업자가 바로 이어갈 수 있는 기록을 남긴다.',
    '',
    '중요한 판단에서는 사실, 가정, 선택지와 trade-off를 구분하고 추천안을 제시해 사용자가 더 나은 결정을 내리도록 돕는다. 결정된 일은 실행 가능한 다음 단계로 전환하고, 맡은 범위에서는 검증 가능한 결과까지 책임 있게 마무리한다.',
    '',
    '사용자의 실제 요청을 우선 수행한다. 기록과 정리를 위해 현재 업무를 불필요하게 지연하지 않는다.',
    '',
    '## 업무 폴더',
    '',
    '- 여러 단계·파일·세션에 걸쳐 이어질 독립적인 업무에는 사람이 목적을 이해할 수 있는 이름의 전용 폴더를 만든다.',
    '- 일회성 요청이나 기존 업무의 작은 하위 작업마다 새 폴더를 만들지 않는다.',
    '- 새 자료는 먼저 기존 업무 폴더에 속하는지 확인한다.',
    '- 처음부터 빈 하위 폴더를 모두 만들지 말고 실제 자료가 생길 때 확장한다.',
    '',
    '업무 폴더에는 필요에 따라 다음을 유지한다.',
    '',
    '- `README.md`: 업무의 존재 이유, 책임 범위, 주요 산출물',
    '- `progress.md`: 현재 상태, 완료한 일, 다음 단계, 막힌 점, 핵심 파일',
    '- `decisions.md`: 중요한 선택, 배경, 검토한 대안, 결정과 근거',
    '',
    '결정이 많아져 한 파일로 이해하기 어려울 때만 `decisions/` 폴더와 날짜가 있는 개별 결정 문서로 확장한다.',
    '',
    '## 프로젝트 지도',
    '',
    '- 루트 `index.md`에는 주요 업무 폴더의 링크와 존재 이유, 현재 상태를 한두 줄로 기록한다.',
    '- 상세 진행 내용을 `index.md`에 복제하지 않는다.',
    '- 관련 업무, 결정, 근거 자료와 산출물은 필요할 때 상대경로 Markdown 링크로 서로 연결한다.',
    '- 파일을 이동하거나 이름을 바꾸면 관련 링크도 함께 갱신한다.',
    '',
    '## 정리와 기록',
    '',
    '- 폴더와 파일 이름은 사람이 목적과 내용을 짐작할 수 있게 짓는다.',
    '- 한 폴더에 성격이 다른 파일이 쌓이면 이해하기 쉬운 하위 구조로 정리한다.',
    '- `misc`, `temp`, `new`, `final-final`처럼 의미가 불분명한 이름을 피한다.',
    '- `progress.md`는 현재 상태판으로 유지하고, 장황한 실행 로그는 별도 기록으로 분리한다.',
    '- 기록에는 결과뿐 아니라 중요한 판단의 이유와 근거 자료의 위치를 남긴다.',
    '- 다음 작업자가 같은 조사와 판단을 반복하지 않을 만큼만 기록한다.',
    '- 프로젝트 전반에 반복 적용되는 안정된 규칙만 이 `AGENTS.md`에 반영한다.',
  ]);
}

function renderProgressSeed(today: string): string {
  return md([
    '# Progress Log',
    '',
    'Compatibility work log for Tower runtime features such as `/agents-md --evolve`.',
    'The people-visible canonical log is `records/work-log.md`; keep this file as a compatibility mirror while the visible scaffold is dogfooded.',
    '',
    'Append dated entries as work progresses. Format: `- YYYY-MM-DD: one-line summary`.',
    '사용자가 `/agents-md --evolve` 를 명시 호출할 때 이 로그와 `records/work-log.md`를 함께 참고해 AGENTS.md가 갱신된다.',
    '',
    '## Entries',
    '',
    `- ${today}: Project created.`,
  ]);
}

function renderWorkLogSeed(today: string): string {
  return md([
    '# Work Log',
    '',
    '프로젝트 작업 일지입니다. 의미 있는 변경, 발견, 결정, 산출물 승격을 한 줄로 남깁니다.',
    '',
    '> 신규 프로젝트의 기본 작업 로그입니다. 기존 프로젝트에 `.project/progress.md`가 있으면 참고만 합니다.',
    '',
    '## Entries',
    '',
    `- ${today}: Project created. Visible scaffold seeded.`,
  ]);
}

function renderDecisionTemplate(): string {
  return md([
    '<!--',
    'Compatibility decision record template for `.project/decisions/`.',
    '',
    'Prefer the visible `decisions/` folder for new human/AI-readable project decisions.',
    'Keep this compatibility path for existing Tower flows until the visible scaffold becomes canonical.',
    '',
    'HOW TO USE:',
    '  1. Copy this file to `YYYY-MM-DD-<slug>.md` in this same directory.',
    '  2. Fill in the sections below.',
    '  3. Commit / save. Do NOT edit later — decisions are immutable.',
    '  4. To change a decision, create a NEW file that supersedes it.',
    '',
    'Team-wide or cross-project decisions belong in `workspace/decisions/` instead.',
    '-->',
    '',
    '# [Decision title]',
    '',
    '**Date**: YYYY-MM-DD',
    '**Status**: proposed | accepted | superseded by <file>',
    '',
    '## Context',
    '',
    'What was the situation, and why did a decision need to be made?',
    '',
    '## Options',
    '',
    '- Option A — pros / cons',
    '- Option B — pros / cons',
    '',
    '## Decision',
    '',
    'What we chose.',
    '',
    '## Rationale',
    '',
    'Why this option over the alternatives. Include constraints and trade-offs.',
  ]);
}

export type ScaffoldSeedFile = {
  relativePath: string;
  contents: string;
};

function renderSourcesReadme(): string {
  return md([
    '# sources/',
    '',
    '들어온 원본 자료를 보관합니다.',
    '',
    '- 여기에 둘 것: 업로드 원본, raw PDF/CSV/JSON, 대본, 스크린샷, 캡처, 가공 전 export.',
    '- 두지 않을 것: 요약본, 초안, 최종본, 반복 가능한 지식.',
    '- 파일명: 가능하면 `YYYY-MM-DD-짧은-출처명.ext`.',
    '- 승격 기준: 분석이 시작되면 `work/`, 공유 가능한 결과가 되면 `final/`, 재사용 지식이 되면 `knowledge/`로 링크하거나 복사한다.',
  ]);
}

function renderWorkReadme(): string {
  return md([
    '# work/',
    '',
    '진행 중 작업, 초안, 분석, build/intermediate 산출물을 둡니다.',
    '',
    '- 여기에 둘 것: drafts, analysis, scripts, dry-runs, migration plans, build outputs.',
    '- 두지 않을 것: 최종 전달 패키지, raw source, 장기 runbook.',
    '- 폴더명: `YYYY-MM-DD-topic` 또는 `<artifact>`.',
    '- 큰 작업 폴더에는 `MANIFEST.md`를 두고 `work/.template.md`를 복사해 시작합니다.',
    '- 승격 기준: 사람/고객/팀에게 그대로 보여줄 수 있으면 `final/`, 반복 가능한 지식이면 `knowledge/`, 앞으로의 행동을 바꾸면 `decisions/`로 승격합니다.',
  ]);
}

function renderWorkTemplate(): string {
  return md([
    '# 작업 제목',
    '',
    'Status: active | paused | abandoned | promoted',
    'Goal:',
    'Owner:',
    'Started:',
    'Current best file:',
    'Promoted to:',
    '',
    '## Context',
    '',
    '## Files',
    '',
    '## Notes',
    '',
    '## Next',
  ]);
}

function renderFinalReadme(): string {
  return md([
    '# final/',
    '',
    '사람/고객/팀에게 보여줄 수 있는 최종본과 전달 패키지를 둡니다.',
    '',
    '- 여기에 둘 것: shareable PDF/PPTX/DOCX/HTML, delivery package, 최종 데이터셋, 재생성 가능한 source bundle.',
    '- 두지 않을 것: 실패한 시도, 임시 build 파일, raw source, 내부 메모.',
    '- 폴더명: `<artifact>` 또는 `YYYY-MM-DD-<artifact>`.',
    '- 큰 산출물 폴더에는 `MANIFEST.md`를 두고 `final/.template.md`를 복사해 포함물과 재생성 방법을 적습니다.',
    '- 최종본이 바뀌면 기존 파일을 덮어쓰기보다 새 버전 또는 superseded note를 남깁니다.',
  ]);
}

function renderFinalTemplate(): string {
  return md([
    '# 산출물 제목',
    '',
    'Status: current | superseded',
    'Promoted from:',
    'Audience:',
    'Primary files:',
    'Date:',
    '',
    '## What this is',
    '',
    '## Included files',
    '',
    '## Regenerate / Source',
    '',
    '## Notes',
  ]);
}

function renderRecordsReadme(): string {
  return md([
    '# records/',
    '',
    '있었던 일을 기록합니다.',
    '',
    '- 여기에 둘 것: work log, customer voice, commitments, incidents, observations, audits, smoke results, operation logs.',
    '- 두지 않을 것: 앞으로 따를 규칙, 재사용 runbook, 최종 전달물.',
    '- 기본 작업 로그: `records/work-log.md`.',
    '- 사건/운영/감사 로그는 필요하면 `records/incidents/`, `records/ops-runs/`, `records/audits/` 같은 하위 폴더로 나눕니다.',
    '- 승격 기준: 반복 가능한 절차는 `knowledge/runbooks/`, 앞으로의 행동을 바꾸는 판단은 `decisions/`로 승격합니다.',
  ]);
}

function renderVisibleDecisionsReadme(): string {
  return md([
    '# decisions/',
    '',
    '앞으로 이 프로젝트에서 따를 판단을 기록합니다.',
    '',
    '- 여기에 둘 것: 프로젝트 안에서 행동을 바꾸는 결정, trade-off, superseding decision.',
    '- 두지 않을 것: routine notes, raw logs, 단순 TODO, 원본 증거.',
    '- 파일명: `YYYY-MM-DD-short-title.md`.',
    '- 템플릿: `decisions/.template.md`.',
    '- 여러 프로젝트나 팀 전체에 영향을 주면 `~/workspace/decisions/`에 기록합니다.',
    '- 기존 프로젝트에 `.project/decisions/`가 있으면 참고할 수 있지만, 새 결정의 기본 위치는 이 폴더입니다.'
  ]);
}

function renderVisibleDecisionTemplate(): string {
  return md([
    '# 결정 제목',
    '',
    '- 날짜: YYYY-MM-DD',
    '- 상태: active | superseded | experimental',
    '- 범위: 이 프로젝트',
    '',
    '## 맥락',
    '',
    '## 결정',
    '',
    '## 근거',
    '',
    '## 영향',
    '',
    '## 재검토 조건',
  ]);
}

function renderKnowledgeReadme(): string {
  return md([
    '# knowledge/',
    '',
    '다음 작업에 재사용할 지식을 둡니다.',
    '',
    '- 여기에 둘 것: patterns, runbooks, glossary, briefs, accepted research, generated indexes.',
    '- 두지 않을 것: raw evidence, work logs, 최종 전달 패키지, 임시 초안.',
    '- 지도 문서: `knowledge/INDEX.md`.',
    '- 반복 가능한 절차는 `knowledge/runbooks/`, 반복 가능한 판단/형식은 `knowledge/patterns/`에 둡니다.',
    '- 출처가 중요한 지식은 `sources/`나 `records/` 링크를 함께 남깁니다.',
  ]);
}

function renderKnowledgeIndexSeed(): string {
  return md([
    '# Knowledge Index',
    '',
    '이 프로젝트에서 재사용할 지식의 지도입니다.',
    '',
    '## Patterns',
    '',
    '- TBD',
    '',
    '## Runbooks',
    '',
    '- TBD',
    '',
    '## Research / Briefs',
    '',
    '- TBD',
  ]);
}

function renderPatternsReadme(): string {
  return md([
    '# knowledge/patterns/',
    '',
    '반복 가능한 판단, 문서 구조, 작업 패턴을 둡니다.',
    '',
    '- 템플릿: `knowledge/patterns/.template.md`.',
    '- 패턴은 특정 작업 로그가 아니라 다음 사람이 재사용할 수 있는 형태로 씁니다.',
  ]);
}

function renderPatternTemplate(): string {
  return md([
    '# Pattern title',
    '',
    'Applies to:',
    'Last updated:',
    '',
    '## Problem',
    '',
    '## Use this when',
    '',
    '## Pattern',
    '',
    '## Example',
    '',
    '## Do not use when',
    '',
    '## Related',
  ]);
}

function renderRunbooksReadme(): string {
  return md([
    '# knowledge/runbooks/',
    '',
    '반복 가능한 절차와 운영 방법을 둡니다.',
    '',
    '- 템플릿: `knowledge/runbooks/.template.md`.',
    '- 실행 로그는 `records/`에 두고, 여기에는 다시 실행 가능한 절차만 남깁니다.',
  ]);
}

function renderRunbookTemplate(): string {
  return md([
    '# Runbook title',
    '',
    'Applies to:',
    'Risk level: low | medium | high',
    'Last tested:',
    '',
    '## When to use',
    '',
    '## Before you start',
    '',
    '## Steps',
    '',
    '## Verify',
    '',
    '## Rollback',
    '',
    '## Notes',
  ]);
}

export function renderVisibleScaffoldFiles(today: string): ScaffoldSeedFile[] {
  return [
    { relativePath: 'sources/README.md', contents: renderSourcesReadme() },
    { relativePath: 'work/README.md', contents: renderWorkReadme() },
    { relativePath: 'work/.template.md', contents: renderWorkTemplate() },
    { relativePath: 'final/README.md', contents: renderFinalReadme() },
    { relativePath: 'final/.template.md', contents: renderFinalTemplate() },
    { relativePath: 'records/README.md', contents: renderRecordsReadme() },
    { relativePath: 'records/work-log.md', contents: renderWorkLogSeed(today) },
    { relativePath: 'decisions/README.md', contents: renderVisibleDecisionsReadme() },
    { relativePath: 'decisions/.template.md', contents: renderVisibleDecisionTemplate() },
    { relativePath: 'knowledge/README.md', contents: renderKnowledgeReadme() },
    { relativePath: 'knowledge/INDEX.md', contents: renderKnowledgeIndexSeed() },
    { relativePath: 'knowledge/patterns/README.md', contents: renderPatternsReadme() },
    { relativePath: 'knowledge/patterns/.template.md', contents: renderPatternTemplate() },
    { relativePath: 'knowledge/runbooks/README.md', contents: renderRunbooksReadme() },
    { relativePath: 'knowledge/runbooks/.template.md', contents: renderRunbookTemplate() },
  ];
}

function writeSeedFileIfMissing(rootDir: string, relativePath: string, contents: string): void {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, contents, 'utf-8');
  }
}

export function seedVisibleScaffold(finalDir: string, today: string): void {
  for (const file of renderVisibleScaffoldFiles(today)) {
    writeSeedFileIfMissing(finalDir, file.relativePath, file.contents);
  }
}

import type { Project as ProjectBase } from '@tower/shared';
import { PROJECT_AGENT_PROFILE_SELECT, projectAgentProfileFromRow } from './project-agent-profile.js';

export interface Project extends ProjectBase {
  userId: number | null;
}

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootPath: row.root_path,
    color: row.color,
    sortOrder: row.sort_order,
    collapsed: row.collapsed,
    archived: row.archived,
    lifecycleStatus: row.lifecycle_status ?? (row.archived ? 'retired' : 'active'),
    retiredAt: row.retired_at ?? null,
    retiredByUserId: row.retired_by_user_id ?? null,
    retirementReason: row.retirement_reason ?? null,
    userId: row.user_id,
    createdAt: row.created_at,
    spaceId: row.space_id ?? null,
    spaceName: row.space_name ?? null,
    spaceSlug: row.space_slug ?? null,
    claude_account_id: row.claude_account_id ?? null,
    systemKey: row.system_key ?? null,
    pinned: Boolean(row.pinned ?? false),
    pinOrder: row.pin_order ?? null,
    agent: config.agentFirstEnabled ? projectAgentProfileFromRow(row) : undefined,
  };
}

const PROJECTS_BASE_QUERY = `
  SELECT p.*, s.name as space_name, s.slug as space_slug,
         ${PROJECT_AGENT_PROFILE_SELECT}
  FROM projects p
  LEFT JOIN spaces s ON p.space_id = s.id
  LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
  WHERE (p.archived IS NULL OR p.archived = 0)
    AND COALESCE(p.lifecycle_status, 'active') = 'active'
    AND p.id = ANY($1::text[])
  ORDER BY p.sort_order, p.created_at
`;

async function applyUserProjectPins(projects: Project[], userId?: number): Promise<Project[]> {
  if (!userId || projects.length === 0) return projects;
  const pins = await query<{ project_id: string; sort_order: number }>(
    'SELECT project_id, sort_order FROM user_project_pins WHERE user_id = $1',
    [userId],
  );
  const pinMap = new Map(pins.map((p) => [p.project_id, p.sort_order]));
  return projects.map((project) => {
    const pinOrder = pinMap.get(project.id);
    return pinOrder === undefined
      ? { ...project, pinned: false, pinOrder: null }
      : { ...project, pinned: true, pinOrder };
  });
}

export async function searchAccessibleProjects(userId: number, role: string, rawQuery: string, limit = 50): Promise<Project[]> {
  const search = rawQuery.trim();
  if (search.length < 2) return [];
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  const accessibleIds = await getAccessibleProjectIds(userId, role);
  if (accessibleIds.length === 0) return [];
  const rows = await query<any>(`
    SELECT p.*, s.name as space_name, s.slug as space_slug,
           ${PROJECT_AGENT_PROFILE_SELECT}
    FROM projects p
    LEFT JOIN spaces s ON p.space_id = s.id
    LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
    WHERE p.id = ANY($2::text[])
      AND p.system_key IS NULL
      AND (
        p.name ILIKE $1
        OR COALESCE(p.description, '') ILIKE $1
        OR COALESCE(pap.display_name, '') ILIKE $1
        OR COALESCE(pap.tagline, '') ILIKE $1
        OR COALESCE(pap.role, '') ILIKE $1
      )
    ORDER BY (p.archived IS NULL OR p.archived = 0) DESC, p.updated_at DESC NULLS LAST, p.created_at DESC
    LIMIT $3
  `, [`%${search}%`, accessibleIds, Math.max(1, Math.min(limit, 100))]);
  return applyUserProjectPins(rows.map(rowToProject), userId);
}

export async function getProjects(userId?: number, role?: string): Promise<Project[]> {
  // Missing authentication is not a request for every project's content.
  if (!userId || !Number.isSafeInteger(userId) || userId <= 0) return [];
  const accessibleIds = await getAccessibleProjectIds(userId, role ?? '');
  if (accessibleIds.length === 0) return [];
  const rows = await query(PROJECTS_BASE_QUERY, [accessibleIds]);
  return applyUserProjectPins(rows.filter(row => accessibleIds.includes(row.id)).map(rowToProject), userId);
}

export async function saveUserProjectPins(userId: number, role: string | undefined, projectIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(projectIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const accessibleIds = await getAccessibleProjectIds(userId, role || '');
  const allowed = new Set(accessibleIds);
  for (const projectId of uniqueIds) {
    if (!allowed.has(projectId)) throw new Error('cannot pin inaccessible project');
  }

  await transaction(async (client) => {
    const db = withClient(client);
    await db.execute('DELETE FROM user_project_pins WHERE user_id = $1', [userId]);
    for (let i = 0; i < uniqueIds.length; i++) {
      await db.execute(
        'INSERT INTO user_project_pins (user_id, project_id, sort_order) VALUES ($1, $2, $3)',
        [userId, uniqueIds[i], i],
      );
    }
  });
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await queryOne(
    `SELECT p.*, s.name as space_name, s.slug as space_slug,
            ${PROJECT_AGENT_PROFILE_SELECT}
     FROM projects p
     LEFT JOIN spaces s ON p.space_id = s.id
     LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
     WHERE p.id = $1`, [id]
  );
  return row ? rowToProject(row) : null;
}

/**
 * Scaffold the on-disk structure for an auto-created project folder.
 * Isolated so createProject() can call it AFTER the DB INSERT has
 * committed — if this throws, the caller rolls back the DB row and
 * best-effort removes any partial folder.
 */
export function scaffoldProjectFolderForCreate(finalDir: string, name: string, description: string | undefined, requireNew = false): void {
  withNewProjectStorage(finalDir, () => seedProjectFolder(finalDir, name, description), { requireNew });
}

function seedProjectFolder(finalDir: string, name: string, description: string | undefined): void {
  // Inherit the provisioned parent's setgid/default ACL and process umask.
  // Never infer a shared Worker from a directory's group or widen an existing
  // ACL mask with chmod: isolated Workers and adopted roots need their own
  // policy. Opt-in same-VM assignment can verify two-way access before activation;
  // missing inheritance requires explicit provisioning, not automatic repair.

  // AGENTS.md is the canonical project instruction file. Do not create a
  // CLAUDE.md compatibility symlink for new projects; legacy projects may still
  // have one, but the scaffold should not teach two files as defaults.
  const desc = description || '이 프로젝트는 아직 목적이 충분히 설명되지 않았습니다. 작업하면서 README/AGENTS를 채워갑니다.';
  const agentsMd = renderProjectAgentsMd(name, desc);
  const agentsMdPath = path.join(finalDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) {
    fs.writeFileSync(agentsMdPath, agentsMd, 'utf-8');
  }


  // Do not seed people-visible semantic folders at project birth. The Knowledge
  // OS buckets (`sources/`, `work/`, `final/`, `records/`, `knowledge/`,
  // `decisions/`) are lazy-created only when real artifacts need them.
  // Decision: workspace/decisions/2026-07-01-new-project-visible-folders-lazy-create.md

  // Seed managed skill manifest for new projects. Project-owned `skills/` stays
  // the override layer; `.tower/skills/manifest.json` supplies the default
  // managed bundle and blocks host-global legacy skill discovery.
  seedProjectDefaultSkills(finalDir, readTeamskillsSkillset(DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS));
}

export async function createProject(
  name: string,
  userId?: number,
  opts?: { description?: string; rootPath?: string; color?: string; spaceId?: number | null; slug?: string; creationCommandId?: string }
): Promise<Project> {
  // ── Dedup guard (defense-in-depth for rapid double-submit) ──
  // A frontend race (e.g. two rapid Enter presses) used to produce two
  // projects sharing a name — the second one gets a `-<uuid8>` suffix on
  // its folder, so users saw two folders appear per "one" create. The
  // primary fix is the synchronous useRef guard in the Sidebar/Header
  // create forms, but we also dedup here so misbehaving clients (or
  // scripts) can't leave orphan slug-suffixed folders behind.
  // Scope: same (userId, trimmed name), created in the last 10 seconds,
  // auto-scaffolded folder only (opts.rootPath=undefined). See
  // workspace/decisions/2026-04-20-project-create-dedup.md.
  if (opts?.creationCommandId) {
    const existing = await queryOne(`SELECT p.*, s.name as space_name, s.slug as space_slug FROM projects p LEFT JOIN spaces s ON p.space_id=s.id WHERE p.creation_command_id=$1`, [opts.creationCommandId]);
    if (existing) return rowToProject(existing);
  }

  if (!opts?.rootPath && !opts?.creationCommandId) {
    const recent = await queryOne(
      `SELECT p.*, s.name as space_name, s.slug as space_slug
       FROM projects p LEFT JOIN spaces s ON p.space_id = s.id
       WHERE p.name = $1
         AND (p.user_id IS NOT DISTINCT FROM $2)
         AND (p.archived IS NULL OR p.archived = 0)
         AND p.created_at > NOW() - INTERVAL '10 seconds'
       ORDER BY p.created_at DESC
       LIMIT 1`,
      [name, userId ?? null]
    );
    if (recent) {
      console.log(`[project-manager] dedup: reusing recent project ${recent.id} (name="${name}", userId=${userId ?? 'null'})`);
      return rowToProject(recent);
    }
  }

  const id = uuidv4();
  const maxOrderRow = await queryOne(
    'SELECT MAX(sort_order) as m FROM projects WHERE user_id IS NULL OR user_id = $1',
    [userId ?? null]
  );
  const maxOrder = maxOrderRow?.m ?? 0;

  // Determine rootPath WITHOUT creating anything on disk yet.
  // Atomicity rule (see workspace/decisions/2026-04-18-session-scoped-write-guard.md):
  //   DB INSERT must land first, THEN folder is scaffolded. If folder creation
  //   fails, the DB row is rolled back so we never leave orphan folders lying
  //   around under workspace/projects/ that don't map to any project.
  let rootPath = opts?.rootPath ?? null;
  let managedDir: string | null = null; // tracks the folder we own & may need to clean up
  if (!rootPath) {
    const requestedSlug = typeof opts?.slug === 'string' && opts.slug.trim().length > 0;
    const baseSlug = requestedSlug ? assertValidProjectSlug(opts!.slug!) : slugify(name);
    if (isReservedSystemProjectSlug(baseSlug)) {
      throw new Error(`Project folder slug is reserved for a Tower system store: ${baseSlug}`);
    }
    if (!requestedSlug && baseSlug === 'project' && /[^\x00-\x7F]/.test(name)) {
      throw new Error('Project folder slug is required when the project name cannot produce an English slug');
    }
    const slug = requestedSlug
      ? baseSlug
      : nextAvailableProjectSlug(baseSlug, (candidate) => (
        fs.existsSync(path.join(WORKSPACE_ROOT, 'projects', candidate))
      ));
    const finalDir = path.join(WORKSPACE_ROOT, 'projects', slug);
    if (requestedSlug && fs.existsSync(finalDir)) {
      throw new Error(`Project folder slug already exists: ${slug}`);
    }
    rootPath = finalDir;
    managedDir = finalDir;
  }

  // 1. DB INSERT first — if this fails, nothing was created on disk.
  await execute(
    `INSERT INTO projects (id, name, description, root_path, color, sort_order, user_id, space_id, creation_command_id, directory_visibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unlisted')`,
    [id, name, opts?.description ?? null, rootPath, opts?.color ?? '#f59e0b', maxOrder + 1, userId ?? null, opts?.spaceId ?? null, opts?.creationCommandId ?? null]
  );

  // 2. Scaffold folder — if this fails, roll back the DB row and clean up any
  //    partial folder so the system is indistinguishable from pre-create state.
  if (managedDir) {
    try {
      scaffoldProjectFolderForCreate(managedDir, name, opts?.description, true);
    } catch (err: any) {
      console.error(`[project-manager] scaffold failed for ${id} (${managedDir}): ${err?.message ?? err} — rolling back DB`);
      // Best-effort DB rollback
      try {
        await execute('DELETE FROM projects WHERE id = $1', [id]);
      } catch (rollbackErr: any) {
        console.error(`[project-manager] DB rollback also failed for ${id}: ${rollbackErr?.message ?? rollbackErr}`);
      }
      // The scaffold wrapper owns exclusive final mkdir and inode-checked
      // cleanup. Never delete managedDir here: a concurrent creator may own it.
      throw err;
    }
  }

  // 3. Record the new Project's canonical host workspace before exposing it to
  //    execution or file routing. This is part of provisioning, not best-effort:
  //    a new Project must never inherit legacy Worker storage by absence.
  try {
    await provisionCanonicalProjectWorkspace({ projectId: id, deploymentId: resolveProjectEnvironmentDeploymentId() });
  } catch (err: any) {
    console.error(`[project-manager] canonical storage provisioning failed for ${id}: ${err?.message ?? err}`);
    try { await execute('DELETE FROM projects WHERE id = $1', [id]); } catch (rollbackErr: any) {
      console.error(`[project-manager] storage rollback also failed for ${id}: ${rollbackErr?.message ?? rollbackErr}`);
    }
    if (managedDir) {
      try { fs.rmSync(managedDir, { recursive: true, force: true }); } catch (cleanupErr: any) {
        console.error(`[project-manager] storage rollback folder cleanup failed for ${id}: ${cleanupErr?.message ?? cleanupErr}`);
      }
    }
    throw err;
  }

  // 4. Auto-add creator as project owner (post-provisioning side effect).
  if (userId) {
    await addProjectMember(id, userId, 'owner');
  }

  // 5. (auto-seed 폐기 — 2026-05-04-five-role-model.md, section E)
  //    이전엔 모든 active non-viewer 사용자를 자동 시드했지만, operator 의
  //    인력 배치 권한과 충돌해서 폐기. 새 프로젝트는 owner 만으로 시작하고,
  //    멤버 추가는 invite 다이얼로그에서 명시적으로.
  //    autoSeedProjectMembers 함수 자체는 group-manager 에 남아 있음 (admin/
  //    operator 가 향후 "팀 전체 일괄 가입" 같은 명시 UI 액션으로 호출 가능).

  // 6. VM-team workspace Credentials are automatically visible to every Project;
  //    no per-Project default policy rows are created.

  // 7. New Projects are not assigned a Worker or static Worker Project scope.
  //    The Project Environment resolver selects a compatible internal executor
  //    at run time. Legacy assignment remains an explicit recovery/migration tool.

  // 8. (Auto-init memkraft memory/ — 폐기됨, 2026-05-09)
  //    이전엔 모든 신규 프로젝트에 memory/ 자동 init 했지만, 9일 운영 후
  //    78개 중 64개(82%)가 빈 채로 남고 사용자가 분산 MD 를 직접 읽지 않음을
  //    확인. 자동 init 의 약속(사람-가독성 + 자연 누적)이 검증 안 됨.
  //    Decision: workspace/decisions/2026-05-09-md-memory-as-ai-only.md
  //    Supersedes (부분 amend): 2026-05-01-ai-first-pm-inversion.md
  //    필요 시 사용자 명시 호출: `cd workspace/projects/<id> && memkraft init`

  return (await getProject(id))!;
}

// ── Default projects: auto-created on first boot, new users auto-join ──

export type DefaultProjectAutoSeedMode = 'all_non_viewer_guest' | 'admin_operator';
export type DefaultProjectAutoJoinMode = 'all_non_viewer_guest' | 'admin_operator' | false;

export interface DefaultProjectDefinition {
  slug: string;
  systemKey?: string;
  name: string;
  color: string;
  description: string;
  /** Backfill existing users into this system project on startup. */
  autoSeedExistingMembers?: DefaultProjectAutoSeedMode;
  /** Add newly created users to this project via auth auto-join. Only explicit public system keys may auto-join. */
  autoJoinNewUsers?: DefaultProjectAutoJoinMode;
  /** Only include this seed when the internal Agent-first flag is enabled. */
  requiresAgentFirst?: boolean;
}

export function defaultProjectsForVm(agentFirstEnabled = config.agentFirstEnabled): DefaultProjectDefinition[] {
  return DEFAULT_PROJECTS.filter((project) => !project.requiresAgentFirst || agentFirstEnabled);
}

export const DEFAULT_PROJECTS: DefaultProjectDefinition[] = [
  { slug: 'general', name: 'General', color: '#3b82f6', description: 'Team-wide shared project for general work' },
  { slug: 'introduction', name: 'Introduction', color: '#6d7fe8', description: 'A friendly guide to getting started with Tower', requiresAgentFirst: true, autoSeedExistingMembers: 'all_non_viewer_guest' },
];

async function ensureIntroductionProfile(projectId: string, rootPath: string): Promise<void> {
  const result = await execute(`INSERT INTO project_agent_profiles
    (project_id, display_name, face, tagline, role, promise, instruction, instruction_source, onboarding_state)
    VALUES ($1, 'Introduction', '👋', 'Tower를 처음 사용하는 분을 위한 친절한 안내자',
      '새 멤버의 첫 사용 안내', '사용자가 자신의 첫 작업을 시작할 수 있도록 돕습니다.', $2, 'system-seed', 'ready')
    ON CONFLICT (project_id) DO NOTHING`, [projectId, INTRODUCTION_INSTRUCTION]);
  // Repair a missing managed block after an interrupted seed, without overwriting
  // an administrator's subsequently edited profile or AGENTS.md.
  const agentsPath = path.join(rootPath, 'AGENTS.md');
  if (result.changes > 0 || (fs.existsSync(agentsPath) && !fs.readFileSync(agentsPath, 'utf8').includes('<!-- tower-primary-agent-profile -->')
    && (await queryOne<{ instruction_source: string }>('SELECT instruction_source FROM project_agent_profiles WHERE project_id = $1', [projectId]))?.instruction_source === 'system-seed')) {
    ensureProjectAgentInstruction(rootPath, {
      displayName: 'Introduction', face: '👋', tagline: 'Tower를 처음 사용하는 분을 위한 친절한 안내자',
      role: '새 멤버의 첫 사용 안내', promise: '사용자가 자신의 첫 작업을 시작할 수 있도록 돕습니다.',
      instruction: INTRODUCTION_INSTRUCTION,
    });
  }
  seedIntroductionGuides(rootPath);
}

const ORGANIZATION_SKILL_SOURCE_DECISION = '~/workspace/decisions/2026-06-26-skills-external-repo-and-no-managed-seed.md';

const SHARED_PROJECT_README = `# Shared

프로젝트 간 임시 공유 드롭박스입니다.

## 사용법

1. 다른 프로젝트와 나누고 싶은 파일을 이 프로젝트의 적절한 폴더에 올립니다.
2. 받는 쪽은 여기서 파일을 자기 프로젝트 안으로 복사해서 사용합니다.
3. 다른 프로젝트 폴더에 직접 쓰거나 symlink를 만들지 않습니다.

## 폴더

- \`incoming/\` — 어디에 둘지 아직 정하지 않은 임시 공유물
- \`docs/\` — 여러 프로젝트에서 참고할 문서 초안
- \`templates/\` — 복사해서 쓸 템플릿 초안
- \`skills/\` — 프로젝트로 복사해 검토할 스킬 초안
- \`archive/\` — 오래되었거나 더 이상 쓰지 않는 공유물

## 주의

- 민감정보, 고객 개인정보, API 키, 비밀번호, 계약 원본은 올리지 마세요.
- 장기적으로 여러 프로젝트에서 계속 쓸 문서나 템플릿은 admin/operator에게 \`workspace/docs/\` 또는 \`workspace/templates/\` 승격을 요청하세요.
- 스킬은 shared에서 바로 전역 실행 대상으로 보지 않습니다. 각 프로젝트로 복사한 뒤 검토하거나 \`/skill-architect\` 및 \`/skill-registry\` 흐름으로 승격하세요.
- 파일을 가져갈 때는 가능하면 출처를 남기세요. 예: \`Source: ~/workspace/projects/shared/docs/example.md\`

근거: \`~/workspace/decisions/2026-06-09-shared-project-dropbox.md\`
`;

const TEAMSKILLS_PROJECT_README = `# teamskills system store

이 경로는 사용자 프로젝트가 아니라 Tower backend가 관리하는 **숨은 조직 스킬 저장소**입니다.

- DB \`projects\` 행이나 프로젝트 사이드바 항목을 만들지 않습니다.
- Canonical organization skills live under \`skills/<skill>/\`.
- \`skillset.json\` lists the skills selected for managed materialization.
- Project runtime copies are generated under each project's \`.tower/skills/\`.
- Skill Share와 admin/operator 관리 흐름 외에는 이 경로에 직접 쓰지 않습니다.
- Do not store secrets or generated runtime copies here.

Decision: ${ORGANIZATION_SKILL_SOURCE_DECISION}
`;

const TEAMSKILLS_SKILLS_README = `# Organization skills

Each folder under this directory is a company-level skill source.

Expected shape:

\`\`\`text
<skill>/
  SKILL.md
  skill.yaml        # optional metadata
  scripts/
  reference/
  examples/
\`\`\`

Do not put secrets, \`.env\`, generated \`.tower/skills\` copies, caches, or large build outputs here.

Decision: ${ORGANIZATION_SKILL_SOURCE_DECISION}
`;


const TEAMSKILLS_AGENTS_APPEND = md([
  '',
  '---',
  '',
  '## teamskills organization skill source rules',
  '',
  'This project is the VM-local organization skill source for this Tower VM/company. Long-term skill history lives in the separate skill repository and syncs here.',
  '',
  'Team members can use this project to create team skills under `skills/<skill>/`, refine existing team skills, and ask the AI to analyze a repeatable workflow before a `SKILL.md` is written.',
  '',
  'Recommended authoring flow:',
  '',
  '- If the workflow is unclear, first ask detailed job-to-be-done questions: user, trigger phrase, inputs, outputs, success criteria, edge cases, required credentials, and forbidden actions.',
  '- Use `/skill-architect` or the skill-architect flow to design, scaffold, smoke-test, and refine the skill.',
  '- Store final organization skill sources under `skills/<skill>/`.',
  '- Do not write generated runtime copies directly; materialize them into project `.tower/skills` folders.',
  '',
  'Canonical organization skill sources live under:',
  '',
  '```text',
  'skills/<skill>/',
  '  SKILL.md',
  '  skill.yaml        # optional metadata',
  '  scripts/',
  '  reference/',
  '  examples/',
  '```',
  '',
  'Runtime copies under project `.tower/skills` folders are generated output. Do not hand-author them.',
  '',
  '### Source layers',
  '',
  '| Layer | Source path | Meaning |',
  '|---|---|---|',
  '| External skill repo | separate skill repository | Long-term versioned skill source. Syncs into teamskills. |',
  '| Organization skill | `~/workspace/projects/teamskills/skills/<skill>` | VM-local company-level source of truth. |',
  '| Project-local skill | `~/workspace/projects/<project>/skills/<skill>` | Only for that project. |',
  '| Runtime generated copy | `~/workspace/projects/<project>/.tower/skills/<skill>` | Generated by materialize. Never hand-edit. |',
  '',
  '### Rules',
  '',
  '- Admin/operator users are default members of this project. Other members are explicit-invite only.',
  '- Invited members may create and edit `skills/<skill>` sources.',
  '- Do not store secrets, `.env`, key/cert files, browser profiles, credential stores, generated artifacts, `node_modules`, caches, or large build outputs here.',
  '- Dangerous delete, overwrite, or bulk move operations must warn that they can affect other collaborators and require the usual confirmation.',
  '- Direct `~/tower/skills/managed` edits are legacy/migration-only. Ordinary company skill work should happen in the separate skill repo or here, then materialize into projects.',
  '- Runtime Box remains project-local; skills should use runtime-safe paths such as `/workspace/.tower/skills/<skill>/...`, not sibling project paths.',
  '- Automatic override is forbidden. If a skill name collides across organization/project layers, materialize should fail or report a collision until a human resolves it.',
  '',
  '### Optional skill metadata',
  '',
  '```yaml',
  'name: html-slide',
  'scope: org',
  'origin: org             # external | org | project | legacy',
  'originVersion: 1.2.0',
  'updatePolicy: forked    # forked | track-external',
  'defaultEnabled: true',
  'requiredSecrets: []',
  'maintainer: team-or-person',
  '```',
  '',
  `Reference decision: ${ORGANIZATION_SKILL_SOURCE_DECISION}`,
]);


function ensureSharedProjectScaffold(rootPath: string): void {
  fs.mkdirSync(rootPath, { recursive: true });
  for (const dir of ['incoming', 'docs', 'templates', 'skills', 'archive']) {
    fs.mkdirSync(path.join(rootPath, dir), { recursive: true });
  }

  const readmePath = path.join(rootPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, SHARED_PROJECT_README, 'utf-8');
  }
}

export function ensureTeamskillsSystemStore(rootPath = path.join(WORKSPACE_ROOT, 'projects', 'teamskills')): void {
  fs.mkdirSync(rootPath, { recursive: true });
  for (const dir of ['skills', 'archive', 'reports']) {
    fs.mkdirSync(path.join(rootPath, dir), { recursive: true });
  }

  const readmePath = path.join(rootPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, TEAMSKILLS_PROJECT_README, 'utf-8');
  }

  const skillsetPath = path.join(rootPath, 'skillset.json');
  if (!fs.existsSync(skillsetPath)) {
    fs.writeFileSync(skillsetPath, JSON.stringify({ version: 1, description: 'Organization skills selected for managed materialization', defaultSkills: [] }, null, 2) + '\n', 'utf-8');
  }

  const skillsReadmePath = path.join(rootPath, 'skills', 'README.md');
  if (!fs.existsSync(skillsReadmePath)) {
    fs.writeFileSync(skillsReadmePath, TEAMSKILLS_SKILLS_README, 'utf-8');
  }

  const agentsPath = path.join(rootPath, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const current = fs.readFileSync(agentsPath, 'utf-8');
    if (!current.includes('## teamskills organization skill source rules')) {
      fs.writeFileSync(agentsPath, current.trimEnd() + TEAMSKILLS_AGENTS_APPEND + '\n', 'utf-8');
    }
  }
}

/** @internal exported for default-project startup seed regression tests. */
export async function findExistingDefaultProject(def: DefaultProjectDefinition): Promise<{ id: string; root_path: string | null } | undefined> {
  const canonicalRoot = path.join(WORKSPACE_ROOT, 'projects', def.slug);

  if (def.systemKey) {
    const byKey = await queryOne<{ id: string; root_path: string | null }>(
      `SELECT id, root_path FROM projects WHERE system_key = $1 AND (archived IS NULL OR archived = 0)`,
      [def.systemKey],
    );
    if (byKey) return byKey;
  }

  // Some default projects were introduced before self-hosted server provisioning and
  // restore flows consistently preserved the canonical DB row. In that state a
  // canonical folder can exist without a matching `projects.root_path`, and the
  // next startup would create `general-2`, then `general-3`, and so on. Resolve
  // by canonical root first, then by exact display name or prior slug-suffixed
  // folders so startup seed never creates another duplicate default Project.
  if (def.slug === 'general' || def.slug === 'shared') {
    return await queryOne<{ id: string; root_path: string | null }>(
      `SELECT id, root_path
       FROM projects
       WHERE (archived IS NULL OR archived = 0)
         AND (
           root_path = $1
           OR lower(name) = lower($3)
           OR root_path LIKE $2
         )
       ORDER BY
         CASE
           WHEN root_path = $1 THEN 0
           WHEN lower(name) = lower($3) THEN 1
           ELSE 2
         END,
         created_at ASC
       LIMIT 1`,
      [canonicalRoot, `${canonicalRoot}-%`, def.name],
    );
  }

  return await queryOne<{ id: string; root_path: string | null }>(
    `SELECT id, root_path FROM projects WHERE root_path = $1 AND (archived IS NULL OR archived = 0)`,
    [canonicalRoot],
  );
}

/**
 * Ensure default projects exist. Called once on server startup.
 * Returns the IDs of default projects (for new-user auto-join).
 */
async function autoSeedDefaultProjectMembers(projectId: string, mode: DefaultProjectAutoSeedMode): Promise<number> {
  if (mode === 'all_non_viewer_guest') return autoSeedProjectMembers(projectId);
  if (mode === 'admin_operator') {
    return execute(`
      INSERT INTO project_members (project_id, user_id, role)
      SELECT $1, u.id, 'member'
      FROM users u
      WHERE u.disabled = 0 AND u.role IN ('admin', 'operator')
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = $1 AND p.user_id IS NULL
          AND p.system_key IN ('general', 'introduction')
          AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active')
      ON CONFLICT DO NOTHING
    `, [projectId]).then((result) => result.changes);
  }
  return 0;
}

function shouldAutoJoinDefaultProject(def: DefaultProjectDefinition, role: string): boolean {
  if (!def.systemKey || !['general', 'introduction'].includes(def.systemKey)) return false;
  const mode = def.autoJoinNewUsers ?? 'all_non_viewer_guest';
  if (mode === false) return false;
  if (!['admin', 'operator', 'member'].includes(role)) return false;
  if (mode === 'admin_operator') return role === 'admin' || role === 'operator';
  return true;
}

export async function seedDefaultProjects(): Promise<string[]> {
  // `teamskills` deliberately lives under workspace/projects for compatibility,
  // but it is a filesystem-only system store: never create a projects DB row,
  // sidebar entry, membership, or session for it.
  ensureTeamskillsSystemStore();

  const ids: string[] = [];
  for (const def of defaultProjectsForVm()) {
    const rootPath = path.join(WORKSPACE_ROOT, 'projects', def.slug);
    const existing = await findExistingDefaultProject(def);
    if (existing) {
      ids.push(existing.id);
      if (def.systemKey) await execute('UPDATE projects SET system_key = $1 WHERE id = $2 AND system_key IS DISTINCT FROM $1', [def.systemKey, existing.id]);
      if (def.slug === 'introduction') {
        await ensureIntroductionProfile(existing.id, existing.root_path ?? rootPath);
        // Preserve explicit directory choices on an existing Project. A fresh
        // seed uses the hidden creation default.
      }
      if (def.slug === 'shared') ensureSharedProjectScaffold(existing.root_path ?? rootPath);
      if (def.slug === 'teamskills') ensureTeamskillsSystemStore(existing.root_path ?? rootPath);
      if (def.autoSeedExistingMembers) {
        try {
          const seeded = await autoSeedDefaultProjectMembers(existing.id, def.autoSeedExistingMembers);
          if (seeded > 0) console.log(`[projects] Added ${seeded} active user(s) to ${def.slug} project`);
        } catch (err) {
          console.warn(`[projects] Failed to auto-seed ${def.slug} project members:`, err);
        }
      }
      continue;
    }
    // Create the project (no userId — system-owned). If the canonical folder
    // already exists without a DB row, adopt it instead of asking createProject
    // to auto-pick a slug-suffixed folder such as `general-2`.
    const project = await createProject(def.name, undefined, {
      description: def.description,
      rootPath: fs.existsSync(rootPath) ? rootPath : undefined,
      color: def.color,
    });
    // Fix slug: createProject may append uuid suffix if slug collision — update if needed
    if (project.rootPath !== rootPath && fs.existsSync(project.rootPath!)) {
      // Rename to clean slug if possible
      if (!fs.existsSync(rootPath)) {
        fs.renameSync(project.rootPath!, rootPath);
        await execute(`UPDATE projects SET root_path = $1 WHERE id = $2`, [rootPath, project.id]);
      }
    }
    if (def.systemKey) await execute('UPDATE projects SET system_key = $1 WHERE id = $2', [def.systemKey, project.id]);
    if (def.slug === 'introduction') await ensureIntroductionProfile(project.id, project.rootPath || rootPath);
    if (def.slug === 'shared') ensureSharedProjectScaffold(rootPath);
    if (def.slug === 'teamskills') ensureTeamskillsSystemStore(rootPath);
    if (def.autoSeedExistingMembers) {
      try {
        const seeded = await autoSeedDefaultProjectMembers(project.id, def.autoSeedExistingMembers);
        if (seeded > 0) console.log(`[projects] Added ${seeded} active user(s) to ${def.slug} project`);
      } catch (err) {
        console.warn(`[projects] Failed to auto-seed ${def.slug} project members:`, err);
      }
    }
    ids.push(project.id);
    console.log(`[projects] Created default project: ${def.name} (${def.slug})`);
  }
  return ids;
}

/** Get IDs of default projects that newly-created users should auto-join. */
export async function getDefaultProjectIds(role = 'member'): Promise<string[]> {
  const ids: string[] = [];
  for (const def of defaultProjectsForVm()) {
    if (!shouldAutoJoinDefaultProject(def, role)) continue;
    const rootPath = path.join(WORKSPACE_ROOT, 'projects', def.slug);
    const row = await findExistingDefaultProject(def);
    if (row && (await queryOne<{ id: string }>(
      `SELECT id FROM projects WHERE id = $1 AND system_key = $2 AND user_id IS NULL
        AND COALESCE(archived, 0) = 0 AND COALESCE(lifecycle_status, 'active') = 'active'`,
      [row.id, def.systemKey],
    ))) ids.push(row.id);
  }
  return ids;
}

export async function updateProject(id: string, updates: Partial<{
  name: string;
  description: string | null;
  rootPath: string | null;
  color: string;
  sortOrder: number;
  collapsed: number;
  archived: number;
  spaceId: number | null;
}>): Promise<Project | null> {
  // ── Display-name rename: keep the filesystem path stable ──
  // Project DB id is the stable identity; rootPath is a working directory with
  // long-lived references from sessions, Runtime Box mounts, publishing source
  // paths, and SDK resume files. Renaming it for every label change creates
  // project-2/project-4 churn and breaks old references. So a name edit only
  // updates the display label plus the project context document title.
  if (updates.name !== undefined) {
    const current = await getProject(id);
    if (current && updates.name !== current.name && current.rootPath) {
      _updateAgentsMdTitle(current.rootPath, current.name, updates.name);
    }
  }

  const sets: string[] = [];
  const vals: any[] = [];
  let paramIdx = 1;
  if (updates.name !== undefined) { sets.push(`name = $${paramIdx++}`); vals.push(updates.name); }
  if (updates.description !== undefined) { sets.push(`description = $${paramIdx++}`); vals.push(updates.description); }
  if (updates.rootPath !== undefined) { sets.push(`root_path = $${paramIdx++}`); vals.push(updates.rootPath); }
  if (updates.color !== undefined) { sets.push(`color = $${paramIdx++}`); vals.push(updates.color); }
  if (updates.sortOrder !== undefined) { sets.push(`sort_order = $${paramIdx++}`); vals.push(updates.sortOrder); }
  if (updates.collapsed !== undefined) { sets.push(`collapsed = $${paramIdx++}`); vals.push(updates.collapsed); }
  if (updates.archived !== undefined) { sets.push(`archived = $${paramIdx++}`); vals.push(updates.archived); }
  if ('spaceId' in updates) { sets.push(`space_id = $${paramIdx++}`); vals.push(updates.spaceId); }
  if (sets.length === 0) return await getProject(id);
  vals.push(id);
  await execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${paramIdx}`, vals);
  return await getProject(id);
}

/**
 * Update the first H1 title in AGENTS.md (or CLAUDE.md) to reflect the new project name.
 */
function _updateAgentsMdTitle(rootPath: string, oldName: string, newName: string): void {
  // Prefer AGENTS.md, fall back to CLAUDE.md for older projects
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  for (const filename of candidates) {
    const filePath = path.join(rootPath, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      let content = fs.readFileSync(filePath, 'utf-8');
      const oldTitle = `# ${oldName}`;
      const newTitle = `# ${newName}`;
      if (content.startsWith(oldTitle)) {
        content = newTitle + content.slice(oldTitle.length);
        fs.writeFileSync(filePath, content, 'utf-8');
      }
      return; // Updated one file — done
    } catch {
      // Non-critical — don't fail the rename if context file update fails
    }
  }
}

/** Retire a Primary Agent while preserving its conversations, files, and ownership records. */
export async function retireProject(id: string, actorUserId: number, reason?: string): Promise<Project | null> {
  return transaction(async (client) => {
    const db = withClient(client);
    const project = await db.queryOne<{ id: string; lifecycle_status: string | null }>(
      'SELECT id, lifecycle_status FROM projects WHERE id = $1 FOR UPDATE', [id],
    );
    if (!project) return null;
    if ((project.lifecycle_status ?? 'active') !== 'active') throw new Error('only an active agent can be retired');

    const result = await db.execute(
      `UPDATE projects
          SET lifecycle_status = 'retired', archived = 1, retired_at = NOW(),
              retired_by_user_id = $2, retirement_reason = $3
        WHERE id = $1`,
      [id, actorUserId, reason?.trim().slice(0, 1000) || null],
    );
    if (!result.changes) return null;

    // External AI Services are disabled but kept for audit and possible restore.
    await db.execute("UPDATE ai_services SET status = 'retired', current_deployment_id = NULL, updated_at = NOW() WHERE owner_project_id = $1 AND status <> 'retired'", [id]);
    await db.execute("UPDATE ai_service_channels SET status = 'disabled', active_deployment_id = NULL, updated_at = NOW() WHERE service_id IN (SELECT id FROM ai_services WHERE owner_project_id = $1)", [id]);
    return rowToProject((await db.queryOne<any>('SELECT * FROM projects WHERE id = $1', [id]))!);
  });
}

/** Restore a retired Primary Agent registration; runtime resources restart lazily. */
export async function restoreProject(id: string): Promise<Project | null> {
  return transaction(async (client) => {
    const db = withClient(client);
    const project = await db.queryOne<{ id: string; lifecycle_status: string | null }>(
      'SELECT id, lifecycle_status FROM projects WHERE id = $1 FOR UPDATE', [id],
    );
    if (!project) return null;
    if ((project.lifecycle_status ?? 'active') !== 'retired') throw new Error('only a retired agent can be restored');
    await db.execute(
      `UPDATE projects SET lifecycle_status = 'active', archived = 0, retired_at = NULL,
                           retired_by_user_id = NULL, retirement_reason = NULL WHERE id = $1`,
      [id],
    );
    return rowToProject((await db.queryOne<any>('SELECT * FROM projects WHERE id = $1', [id]))!);
  });
}

export class SessionRuntimeRebindRequiredError extends Error {
  readonly code = 'SESSION_RUNTIME_REBIND_REQUIRED';

  constructor() {
    super('This session has a pinned runtime and cannot be moved between projects. Create a project transfer instead.');
    this.name = 'SessionRuntimeRebindRequiredError';
  }
}

export async function moveSessionToProject(sessionId: string, projectId: string | null): Promise<boolean> {
  const session = await queryOne<{
    project_id: string | null;
    claude_session_id: string | null;
    pi_session_file: string | null;
    has_runtime_snapshot: boolean;
  }>(
    `SELECT s.project_id, s.claude_session_id, s.pi_session_file,
            EXISTS(SELECT 1 FROM session_runtime_snapshots rs WHERE rs.session_id = s.id) AS has_runtime_snapshot
       FROM sessions s
      WHERE s.id = $1`,
    [sessionId],
  );
  if (!session) return false;

  const targetProjectId = projectId || null;
  const changesProject = session.project_id !== targetProjectId;
  const hasPinnedRuntime = Boolean(session.claude_session_id || session.pi_session_file || session.has_runtime_snapshot);
  if (changesProject && hasPinnedRuntime) throw new SessionRuntimeRebindRequiredError();

  // Validate projectId exists if not null. Sessions without a pinned native
  // runtime may still be reassigned safely because their next turn resolves the
  // target Project's current Runtime Box, Harness, and credential policy.
  if (targetProjectId) {
    const project = await queryOne<{ id: string; root_path: string | null }>('SELECT id, root_path FROM projects WHERE id = $1', [targetProjectId]);
    if (!project) return false;
    const result = await execute('UPDATE sessions SET project_id = $1, cwd = COALESCE($2, cwd) WHERE id = $3', [targetProjectId, project.root_path, sessionId]);
    return result.changes > 0;
  }

  const result = await execute('UPDATE sessions SET project_id = NULL WHERE id = $1', [sessionId]);
  return result.changes > 0;
}

export async function reorderProjects(projectIds: string[]): Promise<void> {
  await transaction(async (client) => {
    const db = withClient(client);
    for (let i = 0; i < projectIds.length; i++) {
      await db.execute('UPDATE projects SET sort_order = $1 WHERE id = $2', [i, projectIds[i]]);
    }
  });
}
