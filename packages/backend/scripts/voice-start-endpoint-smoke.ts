/** Call the real Dev voice start endpoint with a short-lived server-generated JWT. */
import { generateToken } from '../services/auth/auth.js';
import { queryOne } from '../db/pg-repo.js';

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('session id required');
  const user = await queryOne<{ id: number; username: string; role: string }>(`
    SELECT u.id, u.username, u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=$1
  `, [sessionId]);
  if (!user) throw new Error('session user unavailable');
  const token = generateToken({ userId: user.id, username: user.username, role: user.role });
  const inferenceTtsProvider = process.argv.includes('--inworld') ? 'inworld' : 'cartesia';
  const response = await fetch(`http://127.0.0.1:32355/api/sessions/${sessionId}/voice/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inferenceTtsProvider }),
  });
  const body = await response.json();
  console.log(`status=${response.status} ready=${body.ready === true ? 'pass' : 'fail'} error=${body.error || 'none'}`);
  if (!response.ok || body.ready !== true) process.exit(1);
  process.exit(0);
}
main().catch((error) => { console.error(error?.message || error); process.exit(1); });
