import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Exercise the production CLI auth guard without executing CLI main(), reading
// ~/.tower/cli.json, or connecting to any shared database.
const source = readFileSync(new URL('./tower-server-cli.ts', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('async function requireActiveUser('), source.indexOf('async function verifyCliTokenForImport('));
const compiled = ts.transpileModule(`${block}\nexports.requireActiveUser = requireActiveUser;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function setup(row: object | null) {
  const queryOne = vi.fn().mockResolvedValue(row);
  const fail = (message: string): never => { throw new Error(message); };
  const exports: Record<string, unknown> = {};
  new Function('exports', 'queryOne', 'fail', compiled)(exports, queryOne, fail);
  return { guard: exports.requireActiveUser as (payload: object) => Promise<object>, queryOne };
}
const active = { id: 10, username: 'fixture', role: 'member', disabled: 0, approval_status: 'active', auth_epoch: 1 };
it('rejects a pre-disable CLI token after reactivation, including token import/status paths', async () => {
  const { guard, queryOne } = setup(active);
  await expect(guard({ userId: 10, authEpoch: 0, aud: 'tower-cli' })).rejects.toThrow(/revoked/);
  expect(queryOne.mock.calls[0][0]).toContain('auth_epoch');
  await expect(guard({ userId: 10, authEpoch: 1, aud: 'tower-cli' })).resolves.toMatchObject({ userId: 10, authEpoch: 1 });
});
it('keeps untouched legacy tokens only for epoch zero and requires active approval', async () => {
  await expect(setup({ ...active, auth_epoch: 0 }).guard({ userId: 10, aud: 'tower-cli' })).resolves.toMatchObject({ userId: 10, authEpoch: 0 });
  await expect(setup({ ...active, approval_status: 'pending' }).guard({ userId: 10, authEpoch: 1 })).rejects.toThrow(/inactive/);
  await expect(setup(null).guard({ userId: 10, authEpoch: 1 })).rejects.toThrow(/inactive/);
});
