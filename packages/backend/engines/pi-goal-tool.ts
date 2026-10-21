/** Compatibility adapter only. Goal behavior belongs to the Tower service. */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createGoalTools as createTowerGoalTools } from '../services/goal-loop/goal-tools.js';
export type { GoalToolAuthority } from '../services/goal-loop/goal-tools.js';
export function createGoalTools(...args: Parameters<typeof createTowerGoalTools>): ToolDefinition[] {
  return createTowerGoalTools(...args);
}
