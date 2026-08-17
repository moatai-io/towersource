/**
 * secret-cli.ts — admin CLI for sandbox secret store.
 *
 * Usage:
 *   npx tsx packages/backend/scripts/secret-cli.ts <command> [options]
 *
 * Commands:
 *   list                                          — show all secrets (names + scope + grants count)
 *   add    --name N --scope S [--user U] [--description D]
 *                                                 — add or rotate. Value read from stdin (no echo).
 *   show-grants --name N                          — show users granted access
 *   grant  --name N --user U --by ADMIN_ID        — grant a user access
 *   revoke --name N --user U                      — revoke a user's access
 *   delete --name N                               — delete a secret entirely (destructive!)
 *   rotate --name N                               — alias for `add` with same scope/owner (overwrite value)
 *   verify-key                                    — round-trip check master key
 *
 * Designed for fleet-secrets.sh wrapper (ssh + npx tsx). Plain stdin/stdout — no UI.
 *
 * 결정: workspace/decisions/2026-04-29-execution-sandbox-q12-secrets.md
 */

import readline from 'readline';
import { initPg, getPgPool, closePgPool } from '../db/pg.js';
import {
  getSecret,
  setSecret,
  grantSecret,
  revokeSecret,
  deleteSecret,
  listSecrets,
  listGrants,
  verifyMasterKey,
  SecretAccessDeniedError,
  SecretConfigError,
  type SecretScope,
} from '../services/secret/secret-store.js';

// ── Arg parsing (lightweight, no commander dep) ─────────────────────────

interface Args {
  _command: string;
  name?: string;
  scope?: string;
  user?: number;
  by?: number;
  description?: string;
  json?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[++i];
      if (key === 'name') out.name = val;
      else if (key === 'scope') out.scope = val;
      else if (key === 'user') out.user = parseInt(val, 10);
      else if (key === 'by') out.by = parseInt(val, 10);
      else if (key === 'description') out.description = val;
    }
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function readStdinSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    // piped from fleet-secrets.sh or similar
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  // Interactive: prompt without echo
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write('Secret value (input hidden): ');
    // disable echo
    const stdin = process.stdin as any;
    if (stdin.setRawMode) stdin.setRawMode(true);
    let buf = '';
    stdin.on('data', (data: Buffer) => {
      const s = data.toString('utf8');
      if (s === '\n' || s === '\r' || s === '\r\n') {
        if (stdin.setRawMode) stdin.setRawMode(false);
        rl.close();
        process.stderr.write('\n');
        resolve(buf);
      } else if (s === '') {  // Ctrl-C
        process.exit(130);
      } else if (s === '') {  // Backspace
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    });
  });
}

async function getUserId(usernameOrId: number | string): Promise<number> {
  if (typeof usernameOrId === 'number' && Number.isFinite(usernameOrId)) return usernameOrId;
  const pool = getPgPool();
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM users WHERE username = $1', [String(usernameOrId)]);
  if (rows.length === 0) throw new Error(`user not found: ${usernameOrId}`);
  return rows[0].id;
}

async function findSecretId(name: string, scope?: SecretScope, ownerUserId?: number): Promise<number> {
  const pool = getPgPool();
  let query = `SELECT id FROM secret_store WHERE name = $1`;
  const params: unknown[] = [name];
  if (scope) {
    query += ` AND scope = $${params.length + 1}`;
    params.push(scope);
  }
  if (ownerUserId !== undefined) {
    query += ` AND owner_user_id = $${params.length + 1}`;
    params.push(ownerUserId);
  }
  query += ` ORDER BY scope, id LIMIT 1`;
  const { rows } = await pool.query<{ id: number }>(query, params);
  if (rows.length === 0) throw new Error(`secret '${name}' not found`);
  return rows[0].id;
}

// ── Commands ────────────────────────────────────────────────────────────

async function cmdList(args: Args): Promise<void> {
  const all = await listSecrets({ scope: args.scope as SecretScope | undefined });
  if (args.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  if (all.length === 0) {
    console.log('(no secrets)');
    return;
  }
  console.log('NAME'.padEnd(32) + 'SCOPE'.padEnd(10) + 'OWNER'.padEnd(8) + 'GRANTS'.padEnd(8) + 'CREATED');
  console.log('-'.repeat(80));
  for (const s of all) {
    const owner = s.owner_user_id ? `u${s.owner_user_id}` : (s.owner_tool_id ? `t${s.owner_tool_id}` : '-');
    const created = new Date(s.created_at).toISOString().slice(0, 10);
    console.log(
      s.name.padEnd(32) +
      s.scope.padEnd(10) +
      owner.padEnd(8) +
      String(s.granted_user_count).padEnd(8) +
      created,
    );
  }
}

async function cmdAdd(args: Args): Promise<void> {
  if (!args.name) throw new Error('--name required');
  const scope = (args.scope ?? 'global') as SecretScope;
  if (!['global', 'user', 'tool'].includes(scope)) throw new Error(`invalid scope: ${scope}`);
  if (scope === 'user' && !args.user) throw new Error('--user required for scope=user');

  const value = await readStdinSecret();
  if (!value) throw new Error('empty value');

  const createdBy = args.by ?? 1;  // default admin id=1
  const id = await setSecret({
    name: args.name,
    value,
    scope,
    ownerUserId: scope === 'user' ? args.user : undefined,
    description: args.description,
    createdBy,
  });
  console.log(`✅ secret '${args.name}' (scope=${scope}) saved as id=${id}`);
}

async function cmdShowGrants(args: Args): Promise<void> {
  if (!args.name) throw new Error('--name required');
  const id = await findSecretId(args.name);
  const grants = await listGrants(id);
  if (args.json) {
    console.log(JSON.stringify({ secretId: id, name: args.name, grants }, null, 2));
    return;
  }
  if (grants.length === 0) {
    console.log(`(no grants for '${args.name}')`);
    return;
  }
  console.log(`Grants for '${args.name}' (id=${id}):`);
  for (const g of grants) {
    console.log(`  - ${g.username} (uid=${g.user_id})  granted ${new Date(g.granted_at).toISOString().slice(0, 16)}`);
  }
}

async function cmdGrant(args: Args): Promise<void> {
  if (!args.name) throw new Error('--name required');
  if (!args.user) throw new Error('--user required');
  if (!args.by) throw new Error('--by required (admin user id who is granting)');
  const id = await findSecretId(args.name);
  await grantSecret({ secretId: id, userId: args.user, grantedBy: args.by });
  console.log(`✅ '${args.name}' granted to user ${args.user}`);
}

async function cmdRevoke(args: Args): Promise<void> {
  if (!args.name) throw new Error('--name required');
  if (!args.user) throw new Error('--user required');
  const id = await findSecretId(args.name);
  const ok = await revokeSecret({ secretId: id, userId: args.user });
  console.log(ok ? `✅ revoked` : `(no grant existed)`);
}

async function cmdDelete(args: Args): Promise<void> {
  if (!args.name) throw new Error('--name required');
  const id = await findSecretId(args.name);
  const ok = await deleteSecret(id);
  console.log(ok ? `✅ deleted '${args.name}' (id=${id})` : `(not found)`);
}

async function cmdGet(args: Args): Promise<void> {
  // Debug-only: not shown in --help. Used by tests.
  if (!args.name) throw new Error('--name required');
  if (!args.user) throw new Error('--user required');
  try {
    const value = await getSecret(args.name, args.user);
    console.log(value);  // intentional — CLI debug only, no log capture in production
  } catch (e) {
    if (e instanceof SecretAccessDeniedError) {
      console.error(`❌ ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

async function cmdVerifyKey(): Promise<void> {
  const result = verifyMasterKey();
  if (result.ok) {
    console.log('✅ master key valid (round-trip OK)');
  } else {
    console.error(`❌ ${result.reason}`);
    process.exit(1);
  }
}

function printHelp(): void {
  console.error(`
Secret store admin CLI

Commands:
  list [--scope S] [--json]                     List secrets (names + grants count)
  add --name N --scope S [--user U] [--by ADMIN] [--description D]
                                                Add or rotate. Value from stdin.
  show-grants --name N [--json]                 Show users granted access
  grant --name N --user U --by ADMIN_ID         Grant a user access
  revoke --name N --user U                      Revoke a user's access
  delete --name N                               Delete a secret (destructive)
  rotate --name N --scope S [--user U] --by ADMIN
                                                Alias for 'add' (overwrite value)
  verify-key                                    Round-trip master key check
  get --name N --user U                         (debug only) Print value

Examples:
  echo 'sk-...' | npx tsx scripts/secret-cli.ts add --name OPENAI_API_KEY --scope global --by 1
  npx tsx scripts/secret-cli.ts grant --name OPENAI_API_KEY --user 2 --by 1
  npx tsx scripts/secret-cli.ts list
`);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // verify-key doesn't need DB
  if (args._command === 'verify-key') {
    await cmdVerifyKey();
    return;
  }
  if (args._command === 'help' || !args._command) {
    printHelp();
    return;
  }

  await initPg();
  try {
    switch (args._command) {
      case 'list':         await cmdList(args); break;
      case 'add':          await cmdAdd(args); break;
      case 'rotate':       await cmdAdd(args); break;
      case 'show-grants':  await cmdShowGrants(args); break;
      case 'grant':        await cmdGrant(args); break;
      case 'revoke':       await cmdRevoke(args); break;
      case 'delete':       await cmdDelete(args); break;
      case 'get':          await cmdGet(args); break;
      default:
        printHelp();
        process.exit(1);
    }
  } finally {
    await closePgPool();
  }
}

main().catch((e) => {
  if (e instanceof SecretConfigError || e instanceof SecretAccessDeniedError) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
  console.error(`❌ ${(e as Error).message}`);
  process.exit(1);
});
