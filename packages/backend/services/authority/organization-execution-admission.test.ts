import { expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);
import { setOrganizationExecutionAdmission } from './organization-execution-admission.js';
it.each([true, false])('rejects stale organization writes (%s) without DB access', async allowed => {
 await expect(setOrganizationExecutionAdmission({ actorUserId: 1, targetUserId: 2, allowed })).rejects.toThrow('ORGANIZATION_ADMISSION_RETIRED');
 expect(db.execute).not.toHaveBeenCalled();
 expect(db.queryOne).not.toHaveBeenCalled();
});
