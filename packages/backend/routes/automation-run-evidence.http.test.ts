import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryOne: vi.fn(), session: vi.fn(), runs: vi.fn(), automation: vi.fn(), access: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: m.queryOne, query: vi.fn() }));
vi.mock('../services/pm/project-access.js', () => ({ canAccessSession: m.session }));
vi.mock('../services/pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: vi.fn() }));
vi.mock('../services/task/schedule-permissions.js', () => ({ canAccessAutomationJob: m.access }));
import { sanitizeAutomationRunEvidence } from '../services/task/automation-results.js';
import { isUnverifiedAiSpawn } from '../services/task/automation-result-reference.js';

// Execute the actual two GET handlers, not a duplicate implementation. Auth and
// DB are stubs: this is isolated HTTP evidence, not full router/JWT/PG validation.
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
const map = vi.fn();
function handler(route: string): express.RequestHandler {
  const matches: ts.ArrowFunction[] = [];
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(ast) !== 'router'
      || call.expression.name.text !== 'get' || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== route) continue;
    expect(call.arguments[1].getText(ast)).toBe('authMiddleware');
    const fn = call.arguments.at(-1);
    if (fn && ts.isArrowFunction(fn)) matches.push(fn);
  }
  expect(matches).toHaveLength(1);
  const js = ts.transpileModule(`const selected = ${matches[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${js}\nselected;`, {
    getAutomation: m.automation, getAutomationRuns: m.runs, canAccessAutomationJob: m.access,
    getAutomationRunProcessMap: map, canAccessSession: m.session,
    require: (id: string) => {
      if (id.endsWith('/automation-results.js')) return { sanitizeAutomationRunEvidence };
      if (id.endsWith('/automation-result-reference.js')) return { isUnverifiedAiSpawn };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
}
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  for (const route of ['/automations/:id/runs', '/automations/:id/runs/:runId/process-map']) {
    app.get(`/api${route}`, (req, res, next) => {
      if (req.header('x-test-auth') !== 'yes') return res.sendStatus(401);
      (req as any).user = { userId: 7, role: 'member' }; next();
    }, handler(route));
  }
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing address');
  base = `http://127.0.0.1:${address.port}/api/automations/a1/runs`;
});
afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1', automationId: 'a1', status: 'success', mode: 'spawn', resultId: 'task-private', runnerKind: 'ai',
  runnerRef: 'completed-session:session-private', summaryText: 'secret-summary', error: 'secret-error',
  stdoutText: 'secret-stdout', stderrText: 'secret-stderr', errorJson: { private: 'secret-json' },
  ranAt: '2026-09-01T00:00:00Z', durationMs: 4, ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  m.automation.mockResolvedValue({ id: 'a1', projectId: 'p1', jobType: 'ai_prompt', mode: 'spawn' });
  m.access.mockResolvedValue({ allowed: true }); m.runs.mockResolvedValue([run()]);
  m.session.mockResolvedValue({ allowed: false }); m.queryOne.mockResolvedValue({ session_id: 'session-private' });
  map.mockResolvedValue({ sourceRefs: {}, nodes: [], title: 'Safe map' });
});
const get = (suffix = '') => fetch(`${base}${suffix}`, { headers: { 'x-test-auth': 'yes' } });
describe('individual automation run evidence HTTP boundary', () => {
  it('rejects unauthenticated and denied Automation reads before evidence queries', async () => {
    expect((await fetch(base)).status).toBe(401); expect(m.automation).not.toHaveBeenCalled();
    m.access.mockResolvedValue({ allowed: false, status: 403 });
    expect((await get()).status).toBe(403); expect(m.runs).not.toHaveBeenCalled();
  });
  it('redacts every private Session evidence field while retaining run status and timing', async () => {
    const response = await get(); const body = await response.json();
    expect(response.status).toBe(200);
    expect(body[0]).toMatchObject({ status: 'success', ranAt: '2026-09-01T00:00:00Z', resultId: null,
      summaryText: null, error: null, stdoutText: null, stderrText: null, errorJson: null, runnerRef: null });
    expect(JSON.stringify(body)).not.toMatch(/secret-|session-private|task-private/);
  });
  it('resolves a historical task through persisted project scope and marks admission unverified', async () => {
    m.runs.mockResolvedValue([run({ runnerRef: 'task:task-private' })]);
    const body = await (await get()).json();
    expect(body[0]).toMatchObject({ outcomeUnverified: true, resultId: null, summaryText: null });
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining('project_id IS NOT DISTINCT FROM'), ['task-private', 'p1']);
  });
  it('preserves ACL-authorized verified evidence and sessionless non-AI evidence', async () => {
    m.session.mockResolvedValue({ allowed: true });
    m.runs.mockResolvedValue([run(), run({ id: 'r2', mode: 'spawn', runnerKind: 'webhook', runnerRef: null, resultId: null })]);
    const body = await (await get()).json();
    expect(body[0].summaryText).toBe('secret-summary'); expect(body[0].outcomeUnverified).toBeUndefined();
    expect(body[1].summaryText).toBe('secret-summary');
  });
  it.each(['-1', '0', '101', '1.5', '2garbage'])('rejects malformed limit %s before run read', async limit => {
    expect((await get(`?limit=${limit}`)).status).toBe(400); expect(m.runs).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable Session authority', async () => {
    m.session.mockRejectedValue(new Error('Unavailable'));
    expect(JSON.stringify(await (await get()).json())).not.toContain('secret-');
  });
  it('denies private Process Map evidence before projection even when only stdout/errorJson changed', async () => {
    m.runs.mockResolvedValue([run({ resultId: null, runnerRef: null, summaryText: null, error: null })]);
    m.queryOne.mockRejectedValue(new Error('lookup unavailable'));
    // A run with no task identity is sessionless; use the completed-session reference
    // to exercise the private Session gate while all visible summary fields are null.
    m.runs.mockResolvedValue([run({ resultId: null, runnerRef: 'completed-session:session-private', summaryText: null, error: null })]);
    expect((await get('/r1/process-map')).status).toBe(403); expect(map).not.toHaveBeenCalled();
  });
  it('passes caller context to event filtering for an authorized Process Map', async () => {
    m.session.mockResolvedValue({ allowed: true });
    expect((await get('/r1/process-map')).status).toBe(200);
    expect(map).toHaveBeenCalledWith(await m.automation(), run(), { userId: 7, role: 'member' });
  });
});
