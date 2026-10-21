import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../../scripts/worker-scope-assignment-lifecycle.js';
import { readScopeProbeContext } from './worker-scope-execution-probe.js';
import { receiveWorkerProjectFileUpload } from './worker-project-file-upload.js';
import type { WorkerMaintenanceGate } from './worker-maintenance-gate.js';

/** Upload publication only; NOT an execution/shared-Backend-write receipt. The
 * separate execution probe runs a fixed command via normal Worker execution.
 * Installed journal, owner, full scope, root inode, nonce and live PID are checked
 * before/after. No recursive deletion of unknown or substituted scratch paths. */
export async function runWorkerScopeProjectProbe(input: {
  stateFile:string;owner:string;workerId:string;projects:Record<string,string>;gate:WorkerMaintenanceGate;
  assertTrustedState?:(file:string)=>void;
  resolveProjectFile(root:string,relative:string):string;
}) {
  const leave=input.gate.enterProbe(input.owner);if(!leave)throw new Error('SCOPE_PROBE_NOT_OWNER');
  let scratch:string|undefined;let identity:{dev:number;ino:number}|undefined;
  function cleanup() {
    if(!scratch||!identity)return;
    const st=fs.lstatSync(scratch);
    if(!st.isDirectory()||st.isSymbolicLink()||st.dev!==identity.dev||st.ino!==identity.ino)throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');
    const fd=fs.openSync(scratch,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try {
      const pin=fs.fstatSync(fd);if(pin.dev!==st.dev||pin.ino!==st.ino)throw new Error('SCOPE_PROBE_SCRATCH_CHANGED');
      const anchor=`/proc/self/fd/${fd}`;const names=fs.readdirSync(anchor);
      if(names.some(n=>n!=='roundtrip'))throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');
      for(const name of names){const f=fs.lstatSync(path.join(anchor,name));if(!f.isFile()||f.nlink!==1)throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');}
      for(const name of names)fs.unlinkSync(path.join(anchor,name));
      const last=fs.lstatSync(scratch);if(last.dev!==st.dev||last.ino!==st.ino)throw new Error('SCOPE_PROBE_SCRATCH_CHANGED');
      fs.rmdirSync(scratch);scratch=undefined;
    }finally{fs.closeSync(fd);}
  }
  try {
    const c=readScopeProbeContext(input,input.owner);if(c.pid!==process.pid)throw new Error('SCOPE_PROBE_PID_MISMATCH');
    scratch=fs.mkdtempSync(path.join(c.root,'.tower-assignment-probe-'));
    const st=fs.lstatSync(scratch);identity={dev:st.dev,ino:st.ino};
    const relative=path.relative(c.root,path.join(scratch,'roundtrip'));const target=input.resolveProjectFile(c.root,relative);
    if(target!==path.join(scratch,'roundtrip'))throw new Error('SCOPE_PROBE_RESOLVER_MISMATCH');
    const content=Buffer.from(`tower-fixed-project-probe:${c.operationDigest}`);
    await receiveWorkerProjectFileUpload({target,expectedBytes:content.length,chunks:(async function*(){yield content;})()});
    const current=fs.lstatSync(scratch);if(current.dev!==identity.dev||current.ino!==identity.ino)throw new Error('SCOPE_PROBE_SCRATCH_CHANGED');
    if(!fs.readFileSync(input.resolveProjectFile(c.root,relative)).equals(content))throw new Error('SCOPE_PROBE_ROUNDTRIP_FAILED');
    cleanup();
    if(!input.gate.owns(input.owner)||JSON.stringify(readScopeProbeContext(input,input.owner))!==JSON.stringify(c))throw new Error('SCOPE_PROBE_CONTEXT_CHANGED');
    return {owner:c.owner,projectId:c.projectId,rootDigest:digest(c.root),pid:c.pid,scopeDigest:c.scopeDigest,cleaned:true as const};
  }finally{try{cleanup();}finally{leave();}}
}
