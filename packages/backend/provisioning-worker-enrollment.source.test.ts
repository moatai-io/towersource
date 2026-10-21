import {readFileSync} from 'node:fs';import path from 'node:path';import {describe,it,expect} from 'vitest';
const source=(p:string)=>readFileSync(path.resolve(process.cwd(),p),'utf8');
describe('provisioning-only Worker enrollment contracts',()=>{
 it('uses authenticated product transport and atomic first activation, not legacy raw POST',()=>{
  const s=source('packages/backend/scripts/verify-provisioning-worker.ts');expect(s).toContain('createRemoteWorkbenchHttpTransport');expect(s).toContain('resolveWorkbenchWorkerTransportToken');expect(s).toContain('result.execResult.exit_code');expect(s).toContain('requireUnbound:true');expect(s).toContain('activateProjectWorkerFirst');
  const shell=source('scripts/nix-app/enroll-provisioning-worker');expect(shell).toContain('verify-provisioning-worker.js');expect(shell).not.toContain("/v1/runs");expect(shell).not.toContain('activate-oss-local-worker.js');expect(shell).toContain('tower-workbench-worker-tower-provision-local-01-heartbeat.service');expect(shell).toContain('bootstrap-provisioning-worker.js');expect(shell).not.toContain('bootstrap-system-workbench-worker-credentials.js');expect(shell).toContain('TOWER_PROVISIONING_MANAGED_SKILLS_ROOT="$skills"');expect(shell).toContain('TOWER_WORKER_BWRAP_BIN="$closure/bin/tower-provisioning-bwrap"');
 });
 it('keeps no-replay and bounded memory policy with exact current revision',()=>{
  const s=source('scripts/nix-app/enroll-provisioning-worker');expect(s).toContain('worker-intent.json');expect(s).toContain('worker-success.json');expect(s).toContain('TOWER_PROVISIONING_WORKER_ACK');expect(s).toContain('TOWER_LOCAL_WORKER_MEMORY_MAX=2200M');expect(s).toContain('runtime_box_workbench_workers');expect(s).toContain('runtime-compute-doctor" >/dev/null');expect(s).not.toContain('--require-active-worker');expect(s).not.toContain('--worker-url');expect(s).not.toContain('fleet-deploy');
 });
 it('packages runner, fresh scaffold, migrations and native Worker capabilities together',()=>{
  const s=source('flake.nix');for(const name of ['tower-app-provisioning-command','prepare-provisioning-host','enroll-provisioning-worker'])expect(s).toContain('"$out/bin/'+name+'"');expect(s).toContain('cp -R templates/workspace');expect(s).toContain('cp -R skills/managed');expect(s).toContain('"$app/dist/backend/packages/backend/db/migrations/"');expect(s).toContain('${pkgs.bubblewrap}/bin/bwrap');
 });
 it('uses native context, canonical source and exact policy before enrollment',()=>{
  const s=source('scripts/nix-app/enroll-provisioning-worker');expect(s).toContain('provisioning-runtime-context');expect(s).toContain('prepare-provisioning-managed-skills');expect(s).toContain('TOWER_PROVISIONING_SKILLS_CONTRACT');expect(s).toContain('check-worker');expect(s).not.toContain('set -a;source');
  expect(s.indexOf('native compute baseline incomplete')).toBeLessThan(s.indexOf('python3 - "$journal/worker-intent.json"'));
  const context=source('scripts/nix-app/provisioning-runtime-context');expect(context).toContain("'DATABASE_URL'");expect(context).toContain('parse_environment');expect(context).toContain('os.execvpe');expect(context).not.toContain('shell=True');
  const policy=source('scripts/nix-app/prepare-provisioning-bwrap-policy');expect(policy).toContain('--skip-kernel-load');expect(policy).toContain('exact policy approval ACK required');expect(policy).toContain('policySha256');expect(policy).not.toContain('sysctl -w');
 });
 it('packages first-install context and gates with their same-directory dependencies',()=>{
  const flake=source('flake.nix');
  for(const helper of ['provisioning-runtime-context','prepare-provisioning-managed-skills','prepare-provisioning-bwrap-policy','prepare-provisioning-main-https','prepare-provisioning-owner'])expect(flake).toContain('cp ${./scripts/nix-app/'+helper+'} "$out/bin/'+helper+'"');
  expect(flake).toContain('"$out/bin/provisioning-runtime-context"');expect(flake).toContain('"$out/bin/prepare-provisioning-bwrap-policy"');
 });
 it('uses identical signed heartbeat capabilities and never patches native Worker config',()=>{
  const producer=source('packages/backend/scripts/bootstrap-provisioning-worker.ts');expect(producer).toContain("Object.freeze(['file','job','service','shell'])");expect(producer).toContain('capabilities:[...PROVISIONING_WORKER_CAPABILITIES]');expect(producer).toContain('managedSkillsRoot:skills,bwrapBin:bwrap');expect(producer).not.toContain('rotateWorkbenchWorkerIdentity');
  expect(source('scripts/nix-app/enroll-provisioning-worker')).toContain('TOWER_LOCAL_WORKER_CAPABILITIES=job,service,shell,file');
 });
});
