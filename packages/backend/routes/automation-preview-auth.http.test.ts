import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: db.queryOne, query: vi.fn(), execute: vi.fn(), transaction: vi.fn() }));
vi.mock('../config.js', () => ({ config: { authEnabled: true, jwtSecret: 'automation-preview-http-test-only', tokenExpiry: '1h' } }));
import { authMiddleware, generateToken, invalidateAuthCache } from '../services/auth/auth.js';

// The production router imports provider/runtime modules and registers hundreds
// of routes. This mounts the real account-state/JWT middleware with the actual
// A0 handlers, not the full router; no DB, runner or provider may be invoked.
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let server: Server;
let baseUrl: string;

function handler(route: string): express.RequestHandler {
  const matches: ts.ArrowFunction[] = [];
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(ast) !== 'router'
      || call.expression.name.text !== 'post' || !ts.isStringLiteral(call.arguments[0])
      || call.arguments[0].text !== `/automations/:id/${route}`) continue;
    expect(call.arguments[1]?.getText(ast)).toBe('authMiddleware');
    const fn = call.arguments.at(-1);
    if (fn && ts.isArrowFunction(fn)) matches.push(fn);
  }
  expect(matches).toHaveLength(1);
  const js = ts.transpileModule(`const selected = ${matches[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${js}\nselected;`, {});
}

beforeAll(async () => {
  const router = express.Router();
  for (const route of ['full-dry-run', 'observe-dry-run']) {
    router.post(`/automations/:id/${route}`, authMiddleware, handler(route));
  }
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Test server address missing');
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  invalidateAuthCache(901);
  db.queryOne.mockResolvedValue({ password_changed_at: null, disabled: 0, approval_status: 'active', role: 'member' });
});

async function post(route: string, token?: string) {
  return fetch(`${baseUrl}/automations/synthetic-id/${route}`, {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe('retired automation preview with real JWT and account-state middleware', () => {
  it.each(['full-dry-run', 'observe-dry-run'])('%s rejects missing/invalid tokens, then returns 410 for an active account', async route => {
    expect((await post(route)).status).toBe(401);
    expect((await post(route, 'invalid')).status).toBe(401);
    const active = generateToken({ userId: 901, username: 'synthetic', role: 'member' });
    const res = await post(route, active);
    expect(res.status).toBe(410);
    expect((await res.json()).replacement).toBe('/api/automations/:id/run-now');
    expect(db.queryOne).toHaveBeenCalled();
  });

  it('rejects a disabled account before the retired handler', async () => {
    db.queryOne.mockResolvedValue({ password_changed_at: null, disabled: 1, approval_status: 'active', role: 'member' });
    const token = generateToken({ userId: 901, username: 'synthetic', role: 'member' });
    expect((await post('full-dry-run', token)).status).toBe(401);
  });
});
