import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

const { useProjectStore } = await import('./project-store');

const baseProject: any = {
  id: 'project-1', name: '새 동료', description: '', rootPath: '/workspace/new', color: '#fff',
  sortOrder: 0, collapsed: false, archived: false, userId: 1, createdAt: '2026-07-20T00:00:00Z',
  spaceId: null, spaceName: null, spaceSlug: null, systemKey: null, pinned: false, pinOrder: null,
};

describe('project store addProject', () => {
  beforeEach(() => useProjectStore.setState({ projects: [] }));

  it('upserts a fresher Primary Agent shape when WebSocket and creation response race', () => {
    useProjectStore.getState().addProject(baseProject);
    useProjectStore.getState().addProject({ ...baseProject, agent: { projectId: 'project-1', displayName: '업무 자동화 파트너', onboardingState: 'onboarding' } });

    expect(useProjectStore.getState().projects).toHaveLength(1);
    expect(useProjectStore.getState().projects[0].agent).toMatchObject({ displayName: '업무 자동화 파트너', onboardingState: 'onboarding' });
  });
});
