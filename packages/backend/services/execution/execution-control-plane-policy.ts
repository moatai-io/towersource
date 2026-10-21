import type { Automation } from '../task/automation-manager.js';

export const AUTOMATION_EXECUTION_CONTROL_PLANE_FLAG = 'TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED';

export interface AutomationExecutionPathDecision {
  path: 'legacy' | 'execution_control_plane';
  flag: 'on' | 'off' | 'invalid';
  reason: 'enabled_ai_spawn' | 'disabled' | 'invalid_flag' | 'unsupported_job_or_mode';
}

export function selectAutomationExecutionPath(
  automation: Automation,
  env: NodeJS.ProcessEnv = process.env,
): AutomationExecutionPathDecision {
  const raw = env[AUTOMATION_EXECUTION_CONTROL_PLANE_FLAG];
  const flag = raw === 'true' ? 'on' : raw == null || raw === '' || raw === 'false' ? 'off' : 'invalid';
  if (flag === 'invalid') return { path: 'legacy', flag, reason: 'invalid_flag' };
  if (flag === 'off') return { path: 'legacy', flag, reason: 'disabled' };
  if (automation.jobType !== 'ai_prompt' || (automation.mode || 'spawn') !== 'spawn') {
    return { path: 'legacy', flag, reason: 'unsupported_job_or_mode' };
  }
  return { path: 'execution_control_plane', flag, reason: 'enabled_ai_spawn' };
}

export const selectManualAutomationExecutionPath = selectAutomationExecutionPath;
