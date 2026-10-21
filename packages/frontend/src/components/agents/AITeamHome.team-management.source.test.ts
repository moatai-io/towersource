import fs from 'node:fs';
import { expect, it } from 'vitest';
it('restricts the team management entry to explicit admin presentation and mounts only on demand', () => {
 const home = fs.readFileSync(new URL('./AITeamHome.tsx', import.meta.url), 'utf8');
 const app = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
 expect(home).toContain('isAdmin &&');
 expect(home).toContain('showTeamManagement');
 expect(home).toContain('<TeamManagementPanel projects={teammates}');
 expect(app).toContain("isAdmin={tokenPayload?.role === 'admin'}");
});
