/**
 * credential-vault-cli.ts — admin CLI for Workspace Credential Vault MVP.
 *
 * Usage:
 *   npx tsx packages/backend/scripts/credential-vault-cli.ts <command> [options]
 *
 * Commands:
 *   list
 *   add-api-key --id gemini-default --provider gemini --secret-name GEMINI_API_KEY --env-name GEMINI_API_KEY --display "Gemini default" [--scope internal-default] [--by 1]
 *     - secret value is read from stdin; it is never echoed.
 *   grant-project --project-id <uuid> --credential-id gemini-default --mode allow [--env-name GEMINI_API_KEY] [--by 1]
 *   add-gh-target --credential-id gemini-default --project-id <uuid> --repo juliuschun/verita2 --secret-name GEMINI_API_KEY [--by 1]
 *   status-gh --target-id 1 [--by 1]
 *   sync-gh --target-id 1 [--by 1]
 */

import readline from 'readline';
import { initPg, closePgPool } from '../db/pg.js';
import {
  checkGitHubActionsSecretStatus,
  listCredentialProfiles,
  listWorkspaceCredentials,
  setProjectCredentialPolicy,
  setProjectCredentialProfilePolicy,
  syncGitHubActionsSecret,
  upsertApiKeyCredential,
  upsertCredentialProfile,
  upsertGitHubActionsSecretTarget,
} from '../services/credential-vault/credential-vault-service.js';

type Args = Record<string, string | boolean | undefined> & { _command: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { _command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

function str(args: Args, key: string, required = true): string | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (required) throw new Error(`--${key} required`);
  return undefined;
}

function num(args: Args, key: string, fallback?: number): number {
  const value = args[key];
  if (typeof value === 'string') return parseInt(value, 10);
  if (fallback !== undefined) return fallback;
  throw new Error(`--${key} required`);
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
      } else if (s === '\u0003') {
        process.exit(130);
      } else if (s === '\u007f') {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initPg();

  try {
    if (args._command === 'list') {
      const rows = await listWorkspaceCredentials(args.by ? { userId: num(args, 'by', 1), includePersonal: true } : undefined);
      if (args.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log('ID'.padEnd(24) + 'PROVIDER'.padEnd(14) + 'KIND'.padEnd(10) + 'SECRET_NAME'.padEnd(24) + 'SCOPE');
        console.log('-'.repeat(90));
        for (const r of rows) {
          console.log(r.id.padEnd(24) + r.provider.padEnd(14) + r.kind.padEnd(10) + r.secret_name.padEnd(24) + r.scope);
        }
      }
      return;
    }

    if (args._command === 'add-api-key') {
      const secretValue = await readStdinSecret();
      const row = await upsertApiKeyCredential({
        id: str(args, 'id')!,
        provider: str(args, 'provider')!,
        displayName: str(args, 'display', false) ?? str(args, 'id')!,
        secretName: str(args, 'secret-name')!,
        secretValue,
        defaultEnvName: str(args, 'env-name', false),
        scope: (str(args, 'scope', false) as any) ?? 'workspace',
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: true, credential: { id: row.id, provider: row.provider, secret_name: row.secret_name, scope: row.scope } }, null, 2));
      return;
    }

    if (args._command === 'list-profiles') {
      const rows = await listCredentialProfiles();
      if (args.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log('ID'.padEnd(28) + 'PROVIDER'.padEnd(14) + 'TYPE'.padEnd(14) + 'ENV'.padEnd(28) + 'SECRET_REFS');
        console.log('-'.repeat(110));
        for (const r of rows) {
          console.log(
            r.id.padEnd(28) +
            r.provider.padEnd(14) +
            r.profile_type.padEnd(14) +
            Object.keys(r.env || {}).join(',').slice(0, 26).padEnd(28) +
            Object.keys(r.secret_refs || {}).join(','),
          );
        }
      }
      return;
    }

    if (args._command === 'add-profile') {
      const row = await upsertCredentialProfile({
        id: str(args, 'id')!,
        provider: str(args, 'provider')!,
        profileType: (str(args, 'type', false) as any) ?? 'custom',
        displayName: str(args, 'display', false) ?? str(args, 'id')!,
        env: JSON.parse(str(args, 'env-json', false) ?? '{}'),
        secretRefs: JSON.parse(str(args, 'secret-refs-json', false) ?? '{}'),
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: true, profile: { id: row.id, provider: row.provider, profile_type: row.profile_type } }, null, 2));
      return;
    }

    if (args._command === 'grant-profile') {
      await setProjectCredentialProfilePolicy({
        projectId: str(args, 'project-id')!,
        profileId: str(args, 'profile-id')!,
        mode: (str(args, 'mode', false) as any) ?? 'allow',
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: true }, null, 2));
      return;
    }

    if (args._command === 'grant-project') {
      await setProjectCredentialPolicy({
        projectId: str(args, 'project-id')!,
        credentialId: str(args, 'credential-id')!,
        mode: (str(args, 'mode', false) as any) ?? 'allow',
        targetEnvName: str(args, 'env-name', false),
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: true }, null, 2));
      return;
    }

    if (args._command === 'add-gh-target') {
      const row = await upsertGitHubActionsSecretTarget({
        credentialId: str(args, 'credential-id')!,
        projectId: str(args, 'project-id', false) ?? null,
        repo: str(args, 'repo')!,
        secretName: str(args, 'secret-name')!,
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: true, target: { id: row.id, credential_id: row.credential_id, target_ref: row.target_ref } }, null, 2));
      return;
    }

    if (args._command === 'status-gh') {
      const status = await checkGitHubActionsSecretStatus({
        targetId: num(args, 'target-id'),
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify({ ok: status.status !== 'error', ...status }, null, 2));
      return;
    }

    if (args._command === 'sync-gh') {
      const result = await syncGitHubActionsSecret({
        targetId: num(args, 'target-id'),
        actorUserId: num(args, 'by', 1),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Usage: npx tsx packages/backend/scripts/credential-vault-cli.ts <command>

Commands:
  list
  list-profiles
  add-api-key --id ID --provider PROVIDER --secret-name SECRET_NAME [--env-name ENV] [--display NAME] [--scope workspace|internal-default|project]
  grant-project --project-id PROJECT_ID --credential-id ID [--mode inherit|allow|deny|override]
  add-profile --id ID --provider PROVIDER --type llm_backend --display NAME --env-json '{...}' --secret-refs-json '{...}'
  grant-profile --project-id PROJECT_ID --profile-id ID [--mode allow|deny]
  add-gh-target --credential-id ID [--project-id PROJECT_ID] --repo OWNER/REPO --secret-name SECRET_NAME
  status-gh --target-id ID
  sync-gh --target-id ID`);
  } finally {
    await closePgPool();
  }
}

main().catch(err => {
  console.error(`credential-vault-cli error: ${err.message}`);
  process.exit(1);
});
