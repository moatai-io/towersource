/**
 * Minimal admin CLI for the VM-shared Credential Vault.
 *
 * Commands:
 *   list [--scope workspace|project] [--project-id UUID] [--json]
 *   add-api-key --id ID --provider PROVIDER --secret-name NAME
 *     [--env-name ENV] [--display NAME] [--scope workspace|project]
 *     [--project-id UUID] [--by USER_ID]
 *
 * Secret input is read from stdin and is never echoed.
 */

import readline from 'readline';
import { initPg, closePgPool } from '../db/pg.js';
import { listWorkspaceCredentials, upsertApiKeyCredential } from '../services/credential-vault/credential-vault-service.js';

type Args = Record<string, string | boolean | undefined> & { _command: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { _command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { out.json = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function str(args: Args, key: string, required = true): string | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (required) throw new Error(`--${key} required`);
  return undefined;
}

function num(args: Args, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive integer`);
  return parsed;
}

function scope(args: Args): 'workspace' | 'project' {
  const value = str(args, 'scope', false) ?? 'workspace';
  if (value !== 'workspace' && value !== 'project') throw new Error('--scope must be workspace or project');
  return value;
}

async function readStdinSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write('Secret value (input hidden): ');
    const stdin = process.stdin as NodeJS.ReadStream;
    stdin.setRawMode?.(true);
    let buffer = '';
    stdin.on('data', (data: Buffer) => {
      const value = data.toString('utf8');
      if (value === '\n' || value === '\r' || value === '\r\n') {
        stdin.setRawMode?.(false);
        rl.close();
        process.stderr.write('\n');
        resolve(buffer);
      } else if (value === '\u0003') {
        process.exit(130);
      } else if (value === '\u007f') {
        buffer = buffer.slice(0, -1);
      } else {
        buffer += value;
      }
    });
  });
}

function printUsage(): void {
  console.log(`Usage: npx tsx packages/backend/scripts/credential-vault-cli.ts <command>

Commands:
  list [--scope workspace|project] [--project-id UUID] [--json]
  add-api-key --id ID --provider PROVIDER --secret-name NAME [--env-name ENV]
              [--display NAME] [--scope workspace|project] [--project-id UUID] [--by USER_ID]`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initPg();
  try {
    if (args._command === 'list') {
      const selectedScope = scope(args);
      const projectId = str(args, 'project-id', selectedScope === 'project');
      const rows = await listWorkspaceCredentials({ scope: selectedScope, projectId });
      if (args.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log('ID'.padEnd(28) + 'PROVIDER'.padEnd(16) + 'KIND'.padEnd(12) + 'SCOPE'.padEnd(12) + 'PROJECT');
        console.log('-'.repeat(104));
        for (const row of rows) {
          console.log(row.id.padEnd(28) + row.provider.padEnd(16) + row.kind.padEnd(12) + row.scope.padEnd(12) + (row.project_id ?? '-'));
        }
      }
      return;
    }

    if (args._command === 'add-api-key') {
      const selectedScope = scope(args);
      const projectId = str(args, 'project-id', selectedScope === 'project');
      const secretValue = await readStdinSecret();
      const row = await upsertApiKeyCredential({
        id: str(args, 'id')!,
        provider: str(args, 'provider')!,
        displayName: str(args, 'display', false) ?? str(args, 'id')!,
        secretName: str(args, 'secret-name')!,
        secretValue,
        defaultEnvName: str(args, 'env-name', false),
        scope: selectedScope,
        projectId,
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: true, credential: { id: row.id, provider: row.provider, scope: row.scope, projectId: row.project_id } }, null, 2));
      return;
    }

    printUsage();
  } finally {
    await closePgPool();
  }
}

main().catch((error) => {
  console.error(`credential-vault-cli error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
