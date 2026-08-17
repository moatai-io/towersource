/**
 * Owns: conservative risk classification for scheduled job definitions.
 * Public API: classifyJobRisk(). See README.md.
 */
import { classifyCommandRisk } from './command-risk.js';

export type JobRiskLevel = 'low' | 'medium' | 'high';

export function classifyJobRisk(jobType: string, definition: Record<string, unknown> = {}): JobRiskLevel {
  if (jobType === 'ai_prompt') return 'low';

  if (jobType === 'webhook') {
    const method = String((definition as any).method || 'GET').toUpperCase();
    return method === 'GET' || method === 'HEAD' ? 'low' : 'medium';
  }

  if (jobType === 'shell' || jobType === 'workbench_execution') {
    return classifyCommandRisk(String((definition as any).command || ''));
  }

  if (jobType === 'script') {
    const script = String((definition as any).path || '');
    const args = Array.isArray((definition as any).args) ? (definition as any).args.join(' ') : '';
    return classifyCommandRisk(`${script} ${args}`.trim());
  }

  return 'medium';
}
