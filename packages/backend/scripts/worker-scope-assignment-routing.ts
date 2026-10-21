#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { queryOne } from '../db/pg-repo.js';
import { closePgPool } from '../db/pg.js';
/** Signed execution grants authorize commands, never the Worker's static file
 * API. A correctly prepared static scope can use the no-mutation reconciler path;
 * every missing scope, signed or not, belongs to the dedicated coordinator. */
export function chooseScopeAssignmentRoute(input:{signed:boolean;projectId:string;root:string;projects:Record<string,string>;enrolled:boolean}):'legacy-no-mutation'|'dedicated-scope'|'blocked' {
  if(Object.hasOwn(input.projects,input.projectId))return input.projects[input.projectId]===input.root?'legacy-no-mutation':'blocked';
  return input.enrolled?'dedicated-scope':'blocked';
}
/** Launcher read-only dispatch before its SH lock. Dedicated timer owns mutations
 * in its own coordinator cgroup. This process never starts systemd or claims DB. */
export async function inspectAssignmentRoute(env:NodeJS.ProcessEnv=process.env){
  const worker=env.TOWER_PRIMARY_WORKER_ID,dep=env.TOWER_ASSIGNMENT_DEPLOYMENT_ID||'production';
  const config=env.TOWER_ASSIGNMENT_WORKER_CONFIG||path.join(env.HOME||'/nonexistent','.config/tower-workers',`${worker}.json`);
  if(!worker)throw new Error('SCOPE_ROUTE_WORKER_REQUIRED');
  const row=await queryOne<{project_id:string;root_path:string}>(`SELECT d.project_id,p.root_path FROM project_worker_assignment_desires d
    JOIN projects p ON p.id=d.project_id WHERE d.deployment_id=$1 AND d.desired_worker_id=$2 AND d.status='pending'
    ORDER BY d.updated_at,d.project_id LIMIT 1`,[dep,worker]);
  if(!row)return 'legacy-no-mutation';
  return chooseScopeAssignmentRoute({signed:env.TOWER_WORKER_SIGNED_EXECUTION_GRANTS==='true',projectId:row.project_id,root:row.root_path,projects:JSON.parse(fs.readFileSync(config,'utf8')).projects,
    enrolled:env.TOWER_ASSIGNMENT_SERVICE_MANAGER==='system'&&Boolean(env.TOWER_SCOPE_INSTALLATION_POLICY)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void inspectAssignmentRoute().then(route=>{console.log(JSON.stringify({route}));process.exitCode=route==='legacy-no-mutation'?0:route==='dedicated-scope'?21:1;})
    .catch(()=>{console.error('SCOPE_ROUTING_BLOCKED');process.exitCode=1;}).finally(()=>closePgPool());
}
