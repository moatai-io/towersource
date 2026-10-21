import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

function routeBody(route: string): string {
  const start = source.indexOf(`router.post('/automations/:id/${route}'`);
  expect(start, `${route} must remain an explicit compatibility endpoint`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("router.post('/automations/:id/", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('retired automation dry-run routes', () => {
  it.each(['full-dry-run', 'observe-dry-run'])('%s cannot run a saved job', (route) => {
    const body = routeBody(route);
    expect(body).toContain('res.status(410).json(');
    expect(body).toContain("replacement: '/api/automations/:id/run-now'");
    expect(body).not.toContain('runAutomationObserveOnly(');
    expect(body).not.toContain('runAutomationJob(');
  });

  it('keeps condition-only sample evaluation separate from execution', () => {
    const body = routeBody('condition-dry-run');
    expect(body).toContain('evaluateAutomationConditionV1(yaml, stdoutText)');
    expect(body).not.toContain('runAutomationObserveOnly(');
  });
});
