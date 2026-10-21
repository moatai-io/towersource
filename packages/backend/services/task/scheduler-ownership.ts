import { getPgPool } from '../../db/pg.js';
import { resolveProjectEnvironmentDeploymentId } from '../project-environment/project-environment-deployment.js';

/** Development must not consume production schedules from a shared database. */
export function scheduledExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TOWER_SCHEDULER_ENABLED !== undefined) return env.TOWER_SCHEDULER_ENABLED === 'true';
  return resolveProjectEnvironmentDeploymentId(env) === 'production';
}

/** Session advisory lock: one scheduler tick per database, without a long transaction. */
export async function withSchedulerTickLock(run: () => Promise<void>): Promise<void> {
  const client = await getPgPool().connect();
  let locked = false;
  let discard = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(1953462130, 1) AS locked');
    locked = result.rows[0]?.locked === true;
    if (locked) await run();
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(1953462130, 1)'); }
      catch { discard = true; }
    }
    client.release(discard);
  }
}
