import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_PROJECTS, assertValidProjectSlug, defaultProjectsForVm, ensureTeamskillsSystemStore, isReservedSystemProjectSlug, nextAvailableProjectSlug, normalizeProjectSlug, renderVisibleScaffoldFiles, scaffoldProjectFolderForCreate, slugifyProjectName } from './project-manager.js';

describe('project-manager slug helpers', () => {
  it('keeps English project names readable', () => {
    expect(slugifyProjectName('Tower Runtime Box PDF Tools')).toBe('tower-runtime-box-pdf-tools');
    expect(slugifyProjectName('Client A — Q2 Report')).toBe('client-a-q2-report');
  });

  it('translates common Korean project words into readable English slugs', () => {
    expect(slugifyProjectName('한투 리서치')).toBe('hantoo-research');
    expect(slugifyProjectName('고객 제안서 분석')).toBe('customer-proposal-analysis');
    expect(slugifyProjectName('타워 운영 문서')).toBe('tower-ops-docs');
    expect(slugifyProjectName('회사소개서')).toBe('company-profile');
  });

  it('falls back predictably for unknown CJK-only names', () => {
    expect(slugifyProjectName('새 프로젝트')).toBe('project');
  });

  it('uses human-readable numeric collision suffixes', () => {
    const taken = new Set(['hantoo-research', 'hantoo-research-2']);
    expect(nextAvailableProjectSlug('hantoo-research', (slug) => taken.has(slug))).toBe('hantoo-research-3');
  });

  it('normalizes and validates explicit project folder slugs', () => {
    expect(normalizeProjectSlug(' Customer Ops Report ')).toBe('customer-ops-report');
    expect(assertValidProjectSlug('customer-ops-report')).toBe('customer-ops-report');
    expect(() => assertValidProjectSlug('---')).toThrow(/Project folder slug/);
  });

  it('reserves the teamskills filesystem path from user project slugs', () => {
    expect(isReservedSystemProjectSlug('teamskills')).toBe(true);
    expect(isReservedSystemProjectSlug(' TeamSkills ')).toBe(true);
    expect(isReservedSystemProjectSlug('general')).toBe(false);
  });

  it('seeds only General regardless of feature flags and never restores legacy system Projects', () => {
    expect(DEFAULT_PROJECTS).toEqual([
      expect.objectContaining({ slug: 'general', name: 'General' }),
    ]);
    expect(DEFAULT_PROJECTS.map((project) => project.slug)).not.toEqual(expect.arrayContaining(['ai-talent-team', 'shared', 'test-project', 'teamskills']));
    expect(defaultProjectsForVm(false)).toEqual(DEFAULT_PROJECTS);
    expect(defaultProjectsForVm(true)).toEqual(DEFAULT_PROJECTS);
  });

  it('seeds teamskills as a filesystem-only organization store', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-teamskills-store-'));
    const root = path.join(workspace, 'projects', 'teamskills');
    try {
      ensureTeamskillsSystemStore(root);

      expect(fs.existsSync(path.join(root, 'skills'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'archive'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'reports'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'skillset.json'), 'utf8'))).toMatchObject({
        version: 1,
        defaultSkills: [],
      });
      expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('숨은 조직 스킬 저장소');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps visible scaffold seed files available for explicit/lazy materialization only', () => {
    const files = renderVisibleScaffoldFiles('2026-06-23');
    const byPath = new Map(files.map((file) => [file.relativePath, file.contents]));

    expect(byPath.has('sources/README.md')).toBe(true);
    expect(byPath.has('work/.template.md')).toBe(true);
    expect(byPath.has('final/.template.md')).toBe(true);
    expect(byPath.has('records/work-log.md')).toBe(true);
    expect(byPath.has('decisions/.template.md')).toBe(true);
    expect(byPath.has('knowledge/INDEX.md')).toBe(true);
    expect(byPath.has('knowledge/patterns/.template.md')).toBe(true);
    expect(byPath.has('knowledge/runbooks/.template.md')).toBe(true);
    expect(byPath.get('records/work-log.md')).toContain('Visible scaffold seeded');
    expect(byPath.get('work/README.md')).toContain('MANIFEST.md');
  });

  it('does not create visible scaffold folders for a fresh project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-project-scaffold-'));
    try {
      scaffoldProjectFolderForCreate(dir, 'Empty Project', undefined);

      const agentsPath = path.join(dir, 'AGENTS.md');
      expect(fs.existsSync(agentsPath)).toBe(true);
      const agents = fs.readFileSync(agentsPath, 'utf8');
      expect(agents).toContain('<!-- tower-default-agents-template:v2 -->');
      expect(agents).toContain('유능한 비서이자 업무 파트너');
      expect(agents).toContain('`progress.md`');
      expect(agents).toContain('`decisions.md`');
      expect(agents).toContain('루트 `index.md`');
      expect(agents).toContain('상대경로 Markdown 링크');
      for (const folder of ['sources', 'work', 'final', 'records', 'knowledge', 'decisions']) {
        expect(fs.existsSync(path.join(dir, folder))).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
