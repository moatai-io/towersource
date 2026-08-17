/** Secret-free diagnostic for Session Project and LiveKit credential grants. */
import { query } from '../db/pg-repo.js';

async function main() {
  const sessions = await query<any>(`
    SELECT s.id, s.name, s.project_id, s.user_id, s.updated_at, p.name AS project_name
      FROM sessions s LEFT JOIN projects p ON p.id=s.project_id
     WHERE s.updated_at > now() - interval '4 hours'
     ORDER BY s.updated_at DESC LIMIT 20
  `);
  const grants = await query<any>(`
    SELECT c.id, c.provider, c.default_env_name, p.project_id, p.mode, p.target_env_name,
           d.default_mode, d.enabled AS default_enabled
      FROM workspace_credentials c
      LEFT JOIN project_credential_policies p ON p.credential_id=c.id
      LEFT JOIN workspace_connection_defaults d ON d.connection_id='credential:'||c.id
     WHERE c.provider='livekit' OR c.default_env_name LIKE 'LIVEKIT%'
     ORDER BY c.id, p.project_id
  `);
  console.log(JSON.stringify({
    sessions: sessions.map((row) => ({
      id: String(row.id).slice(0, 8), name: row.name, projectId: row.project_id,
      project: row.project_name, userId: row.user_id, updatedAt: row.updated_at,
    })),
    grants,
  }, null, 2));
}

main().catch((error) => { console.error(error?.message || error); process.exit(1); });
