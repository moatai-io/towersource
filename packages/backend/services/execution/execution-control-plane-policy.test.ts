import { describe, expect, it } from 'vitest';
import type { Automation } from '../task/automation-manager.js';
import { AUTOMATION_EXECUTION_CONTROL_PLANE_FLAG, selectManualAutomationExecutionPath } from './execution-control-plane-policy.js';

const automation = { jobType: 'ai_prompt', mode: 'spawn' } as Automation;

describe('manual Automation Execution Control Plane policy', () => {
  it('is explicitly disabled by default', () => {
    expect(selectManualAutomationExecutionPath(automation, {})).toEqual({ path: 'legacy', flag: 'off', reason: 'disabled' });
  });

  it('requires the exact true value and exposes invalid configuration', () => {
    expect(selectManualAutomationExecutionPath(automation, { [AUTOMATION_EXECUTION_CONTROL_PLANE_FLAG]: 'TRUE' }))
      .toEqual({ path: 'legacy', flag: 'invalid', reason: 'invalid_flag' });
    expect(selectManualAutomationExecutionPath(automation, { [AUTOMATION_EXECUTION_CONTROL_PLANE_FLAG]: 'true' }))
      .toEqual({ path: 'execution_control_plane', flag: 'on', reason: 'enabled_ai_spawn' });
  });

  it.each([
    { jobType: 'webhook', mode: 'spawn' },
    { jobType: 'ai_prompt', mode: 'inject' },
    { jobType: 'ai_prompt', mode: 'channel' },
  ])('keeps unsupported job or mode on legacy path: %j', candidate => {
    expect(selectManualAutomationExecutionPath(candidate as Automation, { [AUTOMATION_EXECUTION_CONTROL_PLANE_FLAG]: 'true' }))
      .toEqual({ path: 'legacy', flag: 'on', reason: 'unsupported_job_or_mode' });
  });
});
