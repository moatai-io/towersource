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
    for (const key of ['aiTeamHomeTitle', 'aiTeamHomeDescription', 'aiTeamHelper', 'aiTeammateCount', 'aiTeammateList']) {
      expect(home).toContain(`t('${key}')`);
    }
    expect(home).toContain('turns');
    expect(home).not.toContain('AI 인재팀');
  });
});
