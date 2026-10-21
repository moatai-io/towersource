import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./workbench-project-compute-settings.js', () => ({ getProjectComputeDeploymentBinding: vi.fn(), getProjectComputeSettings: vi.fn() }));
import { getProjectComputeDeploymentBinding as deployment, getProjectComputeSettings as legacy } from './workbench-project-compute-settings.js';
import { resolveEffectiveWorkbenchBinding } from './workbench-effective-binding.js';
beforeEach(() => { vi.resetAllMocks(); vi.mocked(deployment).mockResolvedValue(undefined); vi.mocked(legacy).mockResolvedValue(undefined); });
it('preserves explicit disabled bindings without legacy fallback', async () => {
 const disabled = { workstationMode: false, defaultWorkerId: null } as any;
 vi.mocked(deployment).mockResolvedValue(disabled);
 expect(await resolveEffectiveWorkbenchBinding('p', 'development')).toBe(disabled);
 expect(legacy).not.toHaveBeenCalled();
});
it('never reads legacy settings in production', async () => {
 expect(await resolveEffectiveWorkbenchBinding('p', 'production')).toBeUndefined();
 expect(legacy).not.toHaveBeenCalled();
});
it('supports missing deployment table only through development legacy fallback', async () => {
 vi.mocked(deployment).mockRejectedValue(new Error('relation "project_compute_deployment_bindings" does not exist'));
 vi.mocked(legacy).mockResolvedValue({ defaultWorkerId: 'legacy' } as any);
 expect(await resolveEffectiveWorkbenchBinding('p', 'development')).toMatchObject({ defaultWorkerId: 'legacy' });
});
it('does not convert DB failures into host fallback', async () => {
 vi.mocked(deployment).mockRejectedValue(new Error('connection failed'));
 await expect(resolveEffectiveWorkbenchBinding('p', 'development')).rejects.toThrow('connection failed');
 expect(legacy).not.toHaveBeenCalled();
});
