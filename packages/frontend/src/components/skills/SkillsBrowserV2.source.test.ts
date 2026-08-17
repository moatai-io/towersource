import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve('packages/frontend/src/components/skills/SkillsBrowserV2.tsx');
const source = fs.readFileSync(sourcePath, 'utf-8');

describe('SkillsBrowserV2 source/runtime separation', () => {
  it('uses the four user-facing skill states instead of internal storage terms', () => {
    expect(source).toContain("label: '현재 프로젝트 스킬'");
    expect(source).toContain("label: '팀 공용 스킬'");
    expect(source).toContain("label: 'Tower 제공 스킬'");
    expect(source).toContain("'연결 필요'");
    expect(source).toContain("'실행환경 준비 필요'");
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
    expect(source).toContain('팀 공용 카탈로그만 표시합니다.');
    expect(source).toContain('다시 불러오기');
  });

  it('visualizes the real project plus shared catalog availability structure', () => {
    expect(source).toContain('현재 스킬 구조');
    expect(source).toContain('프로젝트 스킬');
    expect(source).toContain('팀 공용 스킬');
    expect(source).toContain('지금 사용 가능');
    expect(source).toContain('연결 · 실행환경 준비');
  });

  it('keeps the catalog read-only and delegates skill selection to teammate settings', () => {
    expect(source).not.toContain("fetch(`${API}/skills/${skill.id}/toggle`");
    expect(source).not.toContain("label: '켜짐'");
    expect(source).toContain('이 팀원의 설정에서 사용 여부를 정할 수 있는 스킬');
    expect(source).toContain('바로 사용 가능');
  });
});
