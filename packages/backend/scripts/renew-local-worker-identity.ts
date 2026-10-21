#!/usr/bin/env node
/** Same-host trusted maintenance, invoked under the deployment EX lock. */
import { renewLocalWorkerIdentity } from '../services/runtime-box/workbench-worker-identity-renewal.js';
import { closePgPool } from '../db/pg.js';
const worker = process.env.TOWER_PRIMARY_WORKER_ID;
const file = process.env.TOWER_ASSIGNMENT_WORKER_IDENTITY;
try {
  if (!worker || !file) throw new Error('WORKER_RENEW_CONFIG_REQUIRED');
  console.log(JSON.stringify(await renewLocalWorkerIdentity(worker, file)));
} catch {
  // Never serialize credentials, SQL parameters, or JWT parsing errors.
  console.error('WORKER_IDENTITY_RENEWAL_FAILED: operator recovery may be required');
  process.exitCode = 1;
} finally { await closePgPool(); }
