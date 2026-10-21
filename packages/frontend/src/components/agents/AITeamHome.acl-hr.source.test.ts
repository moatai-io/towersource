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
    expect(manager).toContain('accessibleIds.includes(row.id)');
  });

  it('shows teammate role and status management without duplicating work usage', () => {
    for (const key of ['aiTeammateManagement', 'aiTeammateManagementDescription', 'aiTeamHelper', 'aiTeammateCount', 'aiTeammateList', 'manageTeammate']) {
      expect(home).toContain(`t('${key}')`);
    }
    expect(home).not.toContain('dailyTurns');
    expect(home).not.toContain('recentUsage');
    expect(home).not.toContain('AI 인재팀');
  });
});
