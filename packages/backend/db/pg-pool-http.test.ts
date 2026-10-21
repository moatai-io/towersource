import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise exact production route and middleware without booting the monolithic
// api module's unrelated services. This does not test global JWT authentication.
const api = fs.readFileSync('packages/backend/routes/api.ts', 'utf8');
const start = api.indexOf("router.get('/admin/db-pool'");
const end = api.indexOf('\n});', start) + 4;
const auth = fs.readFileSync('packages/backend/services/auth/auth.ts', 'utf8');
const authStart = auth.indexOf('export function operatorOrAboveMiddleware(');
const authEnd = auth.indexOf('\n}', authStart) + 2;
const middleware = new Function(ts.transpile(
  auth.slice(authStart, authEnd).replace('export function', 'function'),
  { target: ts.ScriptTarget.ES2022 },
) + '\nreturn operatorOrAboveMiddleware;')();
let server: Server;
let base: string;
let role: string | undefined;
const diagnostics = vi.fn(() => ({ initialized: true, processId: 123, max: 80, applicationName: 'tower-test', total: 4, idle: 3, waiting: 0 }));
beforeEach(async () => {
  diagnostics.mockClear();
  const app = express();
  app.use((req, _res, next) => { if (role) (req as any).user = { role }; next(); });
  new Function('router', 'operatorOrAboveMiddleware', 'getPgPoolDiagnostics',
    ts.transpile(api.slice(start, end), { target: ts.ScriptTarget.ES2022 }))(app, middleware, diagnostics);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });
it.each([undefined, 'member', 'viewer', 'company_admin'])('rejects role %s before sampling pool', async value => {
  role = value;
  const result = await fetch(`${base}/admin/db-pool`);
  expect(result.status).toBe(403);
  expect(diagnostics).not.toHaveBeenCalled();
});
it.each(['operator', 'admin'])('allows %s with no-store snapshot', async value => {
  role = value;
  const result = await fetch(`${base}/admin/db-pool`);
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.json()).toEqual(diagnostics.mock.results[0].value);
  expect(diagnostics).toHaveBeenCalledTimes(1);
});
