import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./schedule-server.ts', import.meta.url), 'utf8');

describe('schedule MCP control plane contract', () => {
  it.each([
    'create_ai_schedule',
    'list_automations',
    'get_automation',
    'get_automation_runs',
    'propose_automation_change',
    'apply_automation_change',
    'set_automation_enabled',
    'run_automation_now',
    'archive_automation',
  ])('registers %s', (toolName) => {
    expect(source).toContain(`'${toolName}'`);
  });

  it.each(['apply_automation_change', 'set_automation_enabled', 'run_automation_now', 'archive_automation'])('%s requires an exact confirmation literal', (toolName) => {
    const start = source.indexOf(`'${toolName}'`);
    const nextTool = source.indexOf("      tool(\n", start + 10);
    const block = source.slice(start, nextTool < 0 ? source.length : nextTool);
    expect(block).toContain('confirmed: z.literal(true)');
    expect(block).toContain('explicitly confirms');
  });

  it('uses capability checks and the shared audited run service', () => {
    expect(source).toContain("requireAutomationCapability(args.automationId, ctx, 'read')");
    expect(source).toContain("requireAutomationCapability(args.automationId, ctx, 'edit')");
    expect(source).toContain("requireAutomationCapability(args.automationId, ctx, 'run')");
    expect(source).toContain("requireAutomationCapability(args.automationId, ctx, 'archive')");
    expect(source).toContain('const result = await runAutomationNow({');
    expect(source).toContain('createAutomationChangeIntent({');
    expect(source).toContain('applyAutomationChangeIntent({');
  });
});
