/** Installed manager adapter building block. Never execute these arguments through a
 * general sudo wrapper. Service-manager authorization must constrain project mapping.
 * Credential contents/commands live in protected per-run files, never argv or journal.
 */
import path from 'node:path';
import type { InstalledExecutorMapping } from './workstation-executor-capability.js';
export function workstationSystemdRunSpec(input: {
  runId: string; mapping: Readonly<InstalledExecutorMapping>; timeoutSec: number;
  /** Paths allocated by the trusted materializer, not tool request paths. */
  runDirectory: string; environmentFile: string; commandFile: string;
}) {
  if(!/^[a-f0-9-]{36}$/.test(input.runId)||!Number.isInteger(input.timeoutSec)||input.timeoutSec<1||input.timeoutSec>3600)throw new Error('SYSTEMD_RUN_SPEC_INVALID');
  for(const name of [input.runDirectory,input.environmentFile,input.commandFile]){
    if(!path.isAbsolute(name)||path.normalize(name)!==name||/[\0\r\n%]/.test(name))throw new Error('SYSTEMD_RUN_PATH_INVALID');
  }
  if(path.dirname(input.environmentFile)!==input.runDirectory||path.dirname(input.commandFile)!==input.runDirectory)throw new Error('SYSTEMD_RUN_PATH_INVALID');
  const m=input.mapping;
  if(!Number.isSafeInteger(m.commandUid)||m.commandUid<=0||!Number.isSafeInteger(m.commandGid)||m.commandGid<=0)throw new Error('SYSTEMD_RUN_IDENTITY_INVALID');
  for(const value of [m.home,m.projectRoot])if(!path.isAbsolute(value)||path.normalize(value)!==value||/[\0\r\n%]/.test(value))throw new Error('SYSTEMD_RUN_PATH_INVALID');
  const unit=`tower-command-${input.runId}.service`;
  return {unit,args:[
    '--quiet', `--unit=${unit}`, '--service-type=exec',
    `--property=User=${m.commandUid}`,`--property=Group=${m.commandGid}`,
    '--property=SupplementaryGroups=', '--property=NoNewPrivileges=yes',
    '--property=CapabilityBoundingSet=', '--property=Delegate=no',
    '--property=MemoryMax=256M', '--property=TasksMax=64',
    '--property=KillMode=control-group','--property=SendSIGKILL=yes','--property=TimeoutStopSec=3s',
    `--property=RuntimeMaxSec=${input.timeoutSec}s`,
    `--property=WorkingDirectory=${m.projectRoot}`,`--property=Environment="HOME=${m.home.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `--property=EnvironmentFile=${input.environmentFile}`,
    '--property=StandardOutput=null','--property=StandardError=null',
    '--','/bin/sh',input.commandFile,
  ]};
}
