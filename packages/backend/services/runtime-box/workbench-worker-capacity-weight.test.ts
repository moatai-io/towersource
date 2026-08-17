import { describe, expect, it } from 'vitest';
import { classifyWorkbenchWorkerCapacityWeight } from './workbench-worker-capacity-weight.js';

describe('Workbench Worker capacity weight', () => {
  it.each([
    ['echo ok', 'foreground', 1],
    ['python report.py', 'job', 1],
    ['npx playwright test', 'job', 2],
    ['pytest -q', 'job', 2],
    ['pandoc report.md -o report.pdf', 'foreground', 2],
    ['npm run build', 'job', 3],
    ['nix build .#towerApp', 'job', 3],
    ['npm run dev', 'service', 0],
  ] as const)('%s reserves %i capacity units', (command, lifecycle, expected) => {
    expect(classifyWorkbenchWorkerCapacityWeight({ command }, lifecycle)).toBe(expected);
  });
});
