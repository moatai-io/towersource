/** Secret-free check that a non-owner Project member can materialize LiveKit through Project binding. */
import { query } from '../db/pg-repo.js';
import { buildLiveKitAccessFromProjectVault } from '../services/voice-runtime/voice-runtime-env.js';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('project id required');
  const users = await query<{ id: number; username: string }>(`
    SELECT DISTINCT u.id, u.username
      FROM users u
      JOIN project_members pm ON pm.user_id=u.id
     WHERE pm.project_id=$1
     ORDER BY u.id
  `, [projectId]);
  for (const user of users) {
    try {
      const factory = await buildLiveKitAccessFromProjectVault({ projectId, userId: user.id });
      console.log(`user=${user.username} project_binding=${factory ? 'pass' : 'missing'}`);
    } catch (error: any) {
      console.log(`user=${user.username} project_binding=fail reason=${error?.name ?? 'Error'}`);
    }
  }
}
main().catch((error) => { console.error(error?.message || error); process.exit(1); });
