import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve('packages/frontend/src/components/skills/SkillsBrowserV2.tsx');
const source = fs.readFileSync(sourcePath, 'utf-8');

describe('SkillsBrowserV2 source/runtime separation', () => {
  it('uses the four user-facing skill states instead of internal storage terms', () => {
    expect(source).toContain("labelKey: 'originProject'");
    expect(source).toContain("labelKey: 'originCompany'");
    expect(source).toContain("labelKey: 'originTower'");
    expect(source).toContain("t('needsSetup')");
    expect(source).toContain("t('connectionRuntimeReady')");
  });

  it('loads readiness alongside catalog data and keeps provenance in detail metadata', () => {
    expect(source).toContain("fetch(`${API}/me/skill-readiness`");
    expect(source).toContain('readinessBySkill.get(s.name)');
    expect(source).toContain("readinessBySkill.get(skill.name)?.ready !== false");
    expect(source).toContain("['Bundle digest', skill.bundleDigest]");
    expect(source).toContain("['Source commit', skill.sourceCommit]");
  });

  it('falls back to the organization catalog when project-scoped loading fails', () => {
    expect(source).toContain('if (!projectResponse.ok && activeProjectId)');
    expect(source).toContain("skillsResponse = await fetch(`${API}/skills`");
    expect(source).toContain("setLoadError(t('projectSkillsFallback'))");
    expect(source).toContain("t('retryLoad')");
  });

  it('visualizes the real project plus shared catalog availability structure', () => {
    expect(source).toContain("t('currentSkillStructure')");
    expect(source).toContain("t('projectSkill')");
    expect(source).toContain("t('teamSharedSkills')");
    expect(source).toContain("t('readyNow')");
    expect(source).toContain("t('connectionRuntimeReady')");
  });

  it('keeps the catalog read-only and delegates skill selection to teammate settings', () => {
    expect(source).not.toContain("fetch(`${API}/skills/${skill.id}/toggle`");
    expect(source).not.toContain("label: '켜짐'");
    expect(source).toContain("t('teammateSettingsHint')");
    expect(source).toContain("t('readyNow')");
  });
});
