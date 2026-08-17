import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const apiSource = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');

describe('automation mutation route policy contract', () => {
  it('routes create, template create, and legacy YAML apply through the shared mutation policy while config PATCH is blocked', () => {
    const calls = apiSource.match(/authorizeAutomationMutation\(\{/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(apiSource).toContain("import { authorizeAutomationMutation } from '../services/task/automation-mutation-policy.js';");
    expect(apiSource).toContain('riskLevel: mutationPolicy.riskLevel');
  });

  it('does not accept client policy override fields through compatibility PATCH', () => {
    expect(apiSource).toContain("import { classifyAutomationPatch }");
    expect(apiSource).toContain('unknownFields: patch.unknownFields');
    expect(apiSource).not.toContain('const effectiveRiskLevel = riskLevel ||');
  });

  it('applies explicit capabilities to operational routes', () => {
    expect(apiSource).toContain("canAccessAutomationJob(existing, userId, role, 'edit')");
    expect(apiSource).toContain("canAccessAutomationJob(existing, userId, role, 'archive')");
    expect(apiSource).toContain("canAccessAutomationJob(automation, userId, role, 'run')");
    expect(apiSource).toContain("canAccessAutomationJob(automation, userId, role, 'propose')");
  });

  it('restricts deprecated direct YAML apply to confirmed operator legacy use', () => {
    expect(apiSource).toContain('authorizeLegacyDirectAutomationApply({');
    expect(apiSource).toContain('confirmedLegacyDirectApply === true');
    expect(apiSource).toContain("res.setHeader('Deprecation', 'true')");
    expect(apiSource).toContain('applyLegacyAutomationConfig({');
  });

  it('rejects config mutation through compatibility PATCH and routes enabled control separately', () => {
    expect(apiSource).toContain('classifyAutomationPatch(req.body)');
    expect(apiSource).toContain('automation config changes require a reviewed change intent');
    expect(apiSource).toContain("router.post('/automations/:id/enabled'");
    expect(apiSource).toContain('enable/disable change requires explicit confirmation');
  });

  it('checks edit capability for each automation before reorder mutates registry state', () => {
    expect(apiSource).toContain('for (const id of taskIds)');
    expect(apiSource).toContain("const access = await canAccessAutomationJob(automation, userId, role, 'edit');");
    expect(apiSource.indexOf('for (const id of taskIds)')).toBeLessThan(apiSource.indexOf('await reorderAutomations(taskIds.map(String), status);'));
  });
});
