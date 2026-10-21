import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import express from 'express';
import { isUnsupportedAutomationYamlInstructionV1, suggestAutomationYamlEditV1, validateAutomationYamlV1 } from '../../shared/automation-yaml.js';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Execute the actual route handlers from api.ts over HTTP without importing the
// entire production router (DB/providers/startup). Auth is an isolated stub;
// this verifies status, response, and the absence of runner calls at this boundary.
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const routes = ['full-dry-run', 'observe-dry-run'] as const;
const yaml = 'version: 1\nname: Example\ntrigger:\n  type: manual\nrun:\n  type: ai_prompt\n  prompt: test\n';
const fileOps = { mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) };
const getAutomation = vi.fn(async () => ({ id: 'synthetic-id', name: 'Example', projectId: 'p' }));
const getProject = vi.fn(async () => ({ rootPath: '/synthetic-project' }));
const canAccessAutomationJob = vi.fn(async () => ({ allowed: true }));
const runAutomationObserveOnly = vi.fn();
const runAutomationJob = vi.fn();
const runUtilityTextTask = vi.fn();
let server: Server;
let baseUrl: string;

function actualHandler(route: string): express.RequestHandler {
  const matches: ts.ArrowFunction[] = [];
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(ast) !== 'router'
      || call.expression.name.text !== 'post' || !ts.isStringLiteral(call.arguments[0])
      || call.arguments[0].text !== `/automations/:id/${route}`) continue;
    expect(call.arguments[1]?.getText(ast), `${route} must retain auth middleware`).toBe('authMiddleware');
    const fn = call.arguments.at(-1);
    if (fn && ts.isArrowFunction(fn)) matches.push(fn);
  }
  expect(matches, `${route} must have exactly one route handler`).toHaveLength(1);
  const js = ts.transpileModule(`const selected = ${matches[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${js}\nselected;`, {
    runAutomationObserveOnly, runAutomationJob, getAutomation, getProject,
    canAccessAutomationJob, validateAutomationYamlV1, suggestAutomationYamlEditV1,
    isUnsupportedAutomationYamlInstructionV1, runUtilityTextTask, path, fsPromises: fileOps,
    uuidv4: () => 'synthetic-uuid',
  });
}

beforeAll(async () => {
  const router = express.Router();
  for (const route of [...routes, 'save-yaml', 'suggest-yaml-edit']) {
    router.post(`/automations/:id/${route}`, (req, res, next) => {
      if (req.header('x-test-auth') !== 'yes') return res.sendStatus(401);
      (req as any).user = { userId: 7, role: 'member' };
      next();
    }, actualHandler(route));
  }
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No test server address');
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function saveYaml(slug = 'export') {
  return fetch(`${baseUrl}/automations/synthetic-id/save-yaml`, {
    method: 'POST', headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
    body: JSON.stringify({ yaml, slug }),
  });
}

describe('legacy YAML file export over HTTP', () => {
  it('reports that new export does not apply configuration and uses exclusive creation', async () => {
    vi.clearAllMocks();
    const res = await saveYaml();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.configApplied).toBe(false);
    expect(body.sourceOfTruth).toBe(false);
    expect(fileOps.writeFile).toHaveBeenCalledWith('/synthetic-project/automations/export.yaml', yaml, { encoding: 'utf-8', flag: 'wx' });
    expect(fileOps.writeFile).toHaveBeenCalledTimes(2);
    expect(fileOps.writeFile.mock.calls[1][2]).toEqual({ encoding: 'utf-8', flag: 'wx' });
  });

  it('preserves an existing file on collision and creates no history entry', async () => {
    vi.clearAllMocks();
    fileOps.writeFile.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    const res = await saveYaml();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.configApplied).toBe(false);
    expect(body.sourceOfTruth).toBe(false);
    expect(fileOps.writeFile).toHaveBeenCalledTimes(1);
    expect(fileOps.mkdir).toHaveBeenCalledTimes(1); // No history directory created on collision.
  });

  it('reports an incomplete export without claiming that history was saved', async () => {
    vi.clearAllMocks();
    fileOps.writeFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('history unavailable'));
    const res = await saveYaml();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'YAML export was created but history recording failed',
      path: '/synthetic-project/automations/export.yaml', configApplied: false, sourceOfTruth: false,
    });
    expect(fileOps.writeFile).toHaveBeenCalledTimes(2);
  });

  it('rejects unauthenticated file exports before inspecting project or writing files', async () => {
    vi.clearAllMocks();
    const res = await fetch(`${baseUrl}/automations/synthetic-id/save-yaml`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(getAutomation).not.toHaveBeenCalled();
    expect(fileOps.writeFile).not.toHaveBeenCalled();
  });

  it('does not persist unsupported YAML or bypass edit access', async () => {
    vi.clearAllMocks();
    const denied = await fetch(`${baseUrl}/automations/synthetic-id/save-yaml`, {
      method: 'POST', headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: `${yaml}\nreport:\n  policy: always\n` }),
    });
    expect(denied.status).toBe(400);
    expect(fileOps.writeFile).not.toHaveBeenCalled();
    canAccessAutomationJob.mockResolvedValueOnce({ allowed: false, status: 403 } as any);
    expect((await saveYaml()).status).toBe(403);
    expect(fileOps.writeFile).not.toHaveBeenCalled();
  });
});

describe('unsupported automation edit request over HTTP', () => {
  it.each([
    '새 결과가 있을 때만 15분마다 AI를 호출해줘',
    '매일 오전 9시 실행을 오전 10시로 바꿔줘',
    'Change 10:00 to 10:10',
  ])('returns an unchanged plan without calling the LLM for %s', async instruction => {
    vi.clearAllMocks();
    const res = await fetch(`${baseUrl}/automations/synthetic-id/suggest-yaml-edit`, {
      method: 'POST', headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ yaml, instruction }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ yaml, changed: false }));
    expect(runUtilityTextTask).not.toHaveBeenCalled();
  });
});

describe('retired automation preview handlers over HTTP', () => {
  it.each(routes)('%s returns 410 with an explicit actual-execution replacement', async route => {
    vi.clearAllMocks();
    const res = await fetch(`${baseUrl}/automations/synthetic-id/${route}`, {
      method: 'POST', headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: 'version: 1\n' }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain('could execute the saved automation');
    expect(body.replacement).toBe('/api/automations/:id/run-now');
    expect(runAutomationObserveOnly).not.toHaveBeenCalled();
    expect(runAutomationJob).not.toHaveBeenCalled();
  });

  it.each(routes)('%s rejects an unauthenticated request', async route => {
    const res = await fetch(`${baseUrl}/automations/synthetic-id/${route}`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
