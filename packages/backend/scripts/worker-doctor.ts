#!/usr/bin/env node
import { closePgPool } from '../db/pg.js';
import { diagnoseLocalWorkerComponents } from '../services/runtime-box/workbench-worker-doctor-local.js';
import { diagnoseWorkbenchWorker, summarizeWorkbenchWorkerDiagnosis } from '../services/runtime-box/workbench-worker-doctor.js';
const workerId=process.argv[2]?.trim();
if(!workerId){console.error('Usage: worker-doctor <worker-id> [--json]');process.exit(2)}
try{
  const report=await diagnoseWorkbenchWorker(workerId);
  report.checks.push(...diagnoseLocalWorkerComponents(workerId));
  if (report.overall === 'HEALTHY' && report.checks.some(check => !check.ok)) report.overall = 'DEGRADED';
  console.log(process.argv.includes('--json')?JSON.stringify(report,null,2):summarizeWorkbenchWorkerDiagnosis(report));
  process.exitCode=report.overall==='HEALTHY'?0:report.overall==='DEGRADED'?1:2;
}finally{await closePgPool()}
