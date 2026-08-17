import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamHome.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/routes/api.ts'), 'utf8');
const manager = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/services/pm/project-manager.ts'), 'utf8');

describe('AI team home and ACL', () => {
  it('uses only projects already returned through the ACL-filtered project store', () => {
    expect(app).toContain('<AITeamHome projects={projects}');
    expect(api).toContain('res.json(await getProjects(userId, role))');
    expect(manager).toContain('getAccessibleProjectIds(userId, role)');
    expect(manager).toContain('accessibleIds.includes(r.id)');
  });

  it('shows team state, direct creation, helper consultation and per-agent usage', () => {
    for (const copy of ['AI 팀 운영', '지금 확인할 팀 상태', '다음 직급 진행 중', '14일 미사용', '새 AI 팀원 만들기', 'Tower 사용·자동화 상담하기', '최근 7일 turns', '세션 {sessionCount}', 'turns']) {
      expect(home).toContain(copy);
    }
    expect(home).not.toContain('AI 인재팀');
  });
});
