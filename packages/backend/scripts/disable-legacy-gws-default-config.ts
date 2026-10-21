/**
 * Historical cleanup guard.
 *
 * Migration 192 removed Project deny policies and converted the Vault to workspace/project scopes.
 * The legacy gws-default-config cleanup must no longer mutate a simplified database.
 */
import { closePgPool } from '../db/pg.js';

async function main() {
  throw new Error('LEGACY_GWS_CLEANUP_RETIRED: inspect or disable the Credential through the current VM Vault lifecycle API');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => closePgPool().catch(() => {}));
