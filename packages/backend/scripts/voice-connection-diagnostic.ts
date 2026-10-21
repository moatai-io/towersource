/** Secret-free diagnostic for recent Sessions and LiveKit Credentials under the simplified scope model. */
import { query } from '../db/pg-repo.js';

async function main() {
  const sessions = await query<any>(`
    SELECT s.id, s.name, s.project_id, s.user_id, s.updated_at, p.name AS project_name
      FROM sessions s LEFT JOIN projects p ON p.id=s.project_id
     WHERE s.updated_at > now() - interval '4 hours'
     ORDER BY s.updated_at DESC LIMIT 20
  `);
  const credentials = await query<any>(`
    SELECT id, provider, default_env_name, scope, project_id, enabled
      FROM workspace_credentials
     WHERE provider='livekit' OR default_env_name LIKE 'LIVEKIT%'
     ORDER BY scope, project_id NULLS FIRST, id
  `);
  console.log(JSON.stringify({
    sessions: sessions.map((row) => ({
      id: String(row.id).slice(0, 8), name: row.name, projectId: row.project_id,
      project: row.project_name, userId: row.user_id, updatedAt: row.updated_at,
    })),
    credentials,
  }, null, 2));
}

main().catch((error) => { console.error(error?.message || error); process.exit(1); });
