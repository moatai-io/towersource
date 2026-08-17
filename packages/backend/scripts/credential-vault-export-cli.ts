import { initPg, closePgPool } from '../db/pg.js';
import { queryOne } from '../db/pg-repo.js';
import { getSecret } from '../services/secret/secret-store.js';

type Args = Record<string, string | undefined>;
const args: Args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  args[key.slice(2)] = process.argv[++i];
}

async function main() {
  // stdout is a secret-only transport channel. Route lifecycle diagnostics away
  // from it so database startup logs can never be concatenated with the secret.
  console.log = (...values: unknown[]) => console.error(...values);
  const id = args.id;
  const actor = Number(args.by || '1');
  if (!id || !Number.isInteger(actor) || actor <= 0) throw new Error('--id and valid --by required');
  await initPg();
  try {
    const row = await queryOne<{ id: string; secret_name: string; enabled: boolean }>(
      `SELECT id, secret_name, enabled FROM workspace_credentials WHERE id = $1 AND kind = 'api_key'`,
      [id],
    );
    if (!row || !row.enabled) throw new Error('credential missing or disabled');
    const value = await getSecret(row.secret_name, actor);
    if (!value || /[\0\r\n\u0001-\u001f\u007f]/.test(value) || value !== value.trim()) {
      throw new Error('credential value is not safe for env materialization; rotate source credential');
    }
    process.stdout.write(value);
  } finally {
    await closePgPool();
  }
}

main().catch((error) => {
  console.error(`credential-vault-export-cli error: ${error.message}`);
  process.exit(1);
});
