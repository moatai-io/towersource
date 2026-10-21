import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./schedule-server.ts', import.meta.url), 'utf8');

describe('schedule MCP control plane contract', () => {
  it.each([
    'create_ai_schedule',
    'list_automations',
    'get_automation',
    'set_legacy_schedule_enabled',
    'get_automation_runs',
    'propose_automation_change',
    'apply_automation_change',
    'set_automation_enabled',
    'run_automation_now',
    'archive_automation',
  ])('registers %s', (toolName) => {
    expect(source).toContain(`'${toolName}'`);
  });

  it.each(['apply_automation_change', 'set_automation_enabled', 'set_legacy_schedule_enabled', 'run_automation_now', 'archive_automation'])('%s requires an exact confirmation literal', (toolName) => {
    const start = source.indexOf(`'${toolName}'`);
    const nextTool = source.indexOf("      tool(\n", start + 10);
    const block = source.slice(start, nextTool < 0 ? source.length : nextTool);
    expect(block).toContain('confirmed: z.literal(true)');
    expect(block).toContain('explicitly confirms');
  });

  it('lists the complete schedule inventory, including active legacy tasks', () => {
    expect(source).toContain('listScheduleInventory({');
    expect(source).toContain("source: 'legacy_task'");
    expect(source).toContain('setLegacyScheduledTaskEnabled({');
  });

  it('uses capability checks and the shared audited run service', () => {
    expect(source).toContain("requireAutomationCapability(args.automationId, actor, 'read')");
    expect(source).toContain("requireAutomationCapability(args.automationId, actor, 'edit')");
    expect(source).toContain("requireAutomationCapability(args.automationId, actor, 'run')");
    expect(source).toContain("requireAutomationCapability(args.automationId, actor, 'archive')");
    expect(source).toContain('const result = await runAutomationNow({');
    expect(source).toContain('createAutomationChangeIntent({');
    expect(source).toContain('applyAutomationChangeIntent({');
  });
});
