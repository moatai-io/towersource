/** Secret-free Google Connection inventory under the simplified workspace/project scope model. */
import { closePgPool } from '../db/pg.js';
import { query } from '../db/pg-repo.js';

async function main() {
  const rows = await query<any>(`
    SELECT id, display_name, scope, project_id, metadata, enabled, updated_at
      FROM workspace_credentials
     WHERE provider = 'google' AND kind = 'gws'
     ORDER BY scope, project_id NULLS FIRST, id
  `);
  console.log(JSON.stringify(rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    scope: row.scope,
    projectId: row.project_id ?? null,
    googleAccount: row.metadata?.google_account ?? null,
    enabled: row.enabled === true,
    updatedAt: new Date(row.updated_at).toISOString(),
  })), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => closePgPool().catch(() => {}));
