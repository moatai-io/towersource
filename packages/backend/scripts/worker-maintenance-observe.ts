#!/usr/bin/env node
/** Read-only maintenance observation using the normal DB configuration. Emits only
 * counts, heartbeat and public identity; errors never expose provider/DB messages. */
import pg from 'pg';
const workerId = process.argv[2];
const deploymentId = process.argv[3];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000, max: 1 });
try {
  if (!process.env.DATABASE_URL || !workerId || !deploymentId) throw new Error('CONFIG');
  const { rows } = await pool.query(`SELECT w.worker_id, w.draining,
    EXTRACT(EPOCH FROM (NOW()-w.heartbeat_at))::float AS heartbeat_age,
    EXTRACT(EPOCH FROM w.heartbeat_at)::float AS heartbeat_at,
    w.metadata_json->>'deploymentId' AS deployment_id,
    (SELECT count(*)::int FROM runtime_box_workbench_worker_capacity_reservations r
      WHERE r.worker_id=w.worker_id AND r.state='reserved') AS reservations,
    (SELECT count(*)::int FROM runtime_box_services s WHERE s.worker_id=w.worker_id
      AND s.status NOT IN ('stopped','failed','expired','error')) AS services
    FROM runtime_box_workbench_workers w WHERE worker_id=$1`, [workerId]);
  const row = rows[0];
  if (!row || row.deployment_id !== deploymentId || row.heartbeat_age < 0 || row.heartbeat_age > 15) throw new Error('UNKNOWN');
  process.stdout.write(JSON.stringify({ workerId, deploymentId, draining: row.draining,
    heartbeatAge: row.heartbeat_age, heartbeatAt: row.heartbeat_at, reservations: row.reservations, services: row.services }));
} catch { process.stdout.write(JSON.stringify({ error: 'MAINTENANCE_DB_OBSERVATION_UNAVAILABLE' })); process.exitCode = 1; }
finally { await pool.end(); }
