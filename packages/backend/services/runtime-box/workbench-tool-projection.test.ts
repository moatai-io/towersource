import { describe, expect, it } from 'vitest';
import {
  runtimeWorkbenchToolDockerMountArgs,
  WORKBENCH_TOOL_PROJECTION_TARGET,
  type WorkbenchToolProjectionPlan,
} from './workbench-tool-projection.js';

describe('Workbench tool read-only projection', () => {
  it('emits one immutable child bind mount for the active revision', () => {
    const plan: WorkbenchToolProjectionPlan = {
      enabled: true,
      projectId: 'project-1',
      revision: 4,
      manifestHash: 'a'.repeat(64),
      storeRef: 'projects/project-1/revisions/000004',
      sourcePath: '/data/runtime-box/workbench-tools/projects/project-1/revisions/000004',
      targetPath: WORKBENCH_TOOL_PROJECTION_TARGET,
      reason: 'managed_revision_ready',
    };
    expect(runtimeWorkbenchToolDockerMountArgs(plan)).toEqual([
      '--mount',
      'type=bind,src=/data/runtime-box/workbench-tools/projects/project-1/revisions/000004,dst=/workspace/.runtime-box/workbench-tools/active,readonly,bind-propagation=rprivate',
    ]);
  });

  it('does not mount disabled or uninitialized state', () => {
    expect(runtimeWorkbenchToolDockerMountArgs({
      enabled: false,
      projectId: 'project-1',
      revision: null,
      manifestHash: null,
      storeRef: null,
      targetPath: WORKBENCH_TOOL_PROJECTION_TARGET,
      reason: 'uninitialized',
    })).toEqual([]);
  });
});
