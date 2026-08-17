import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workbench = fs.readFileSync(path.join(import.meta.dirname, 'workbench-tools.ts'), 'utf8');
const manager = fs.readFileSync(path.join(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');

describe('A4a boundaries after A4b rebuild', () => {
  it('keeps all revision writers on shared M without requiring a Runtime Box row', () => {
    expect(workbench.match(/withWorkbenchMutationLock\(input\.projectId/g)).toHaveLength(3);
    const install = workbench.slice(workbench.indexOf('export async function installUvWorkbenchTool'), workbench.indexOf('export function classifyWorkbenchToolRuntimeObservation'));
    expect(install).not.toContain('project_runtime_boxes');
  });

  it('keeps mutation runner independent from the long exec A lock', () => {
    const start = manager.indexOf('export async function execWorkbenchToolMutation');
    const end = manager.indexOf('\nexport ', start + 20);
    const mutation = manager.slice(start, end === -1 ? undefined : end);
    expect(mutation).not.toContain('withRuntimeBoxActivityLock');
    expect(mutation).not.toContain('runtime-box-activity:');
  });
});
