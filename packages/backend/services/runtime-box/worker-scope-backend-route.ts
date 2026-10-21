import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { assertScopeInstalledFile, loadScopeInstallationPolicy } from '../../scripts/worker-scope-installation.js';
import { assertScopeBackendIdentity, createBackendScopeSharedWriteProbe, requireEmptyScopeProbeRequest } from './worker-scope-execution-probe.js';

/** Mount BEFORE body parsers and generic API/SPA routes. Disabled without explicit
 * root-installed policy. Requests do not configure this listener or any path. */
export function createScopeBackendRoute(policyFile:string,token:()=>string):RequestHandler {
  const c=loadScopeInstallationPolicy(policyFile);const policyBytes=fs.readFileSync(policyFile);
  const config=()=>{assertScopeInstalledFile(c.configFile);return JSON.parse(fs.readFileSync(c.configFile,'utf8'));};
  const probe=createBackendScopeSharedWriteProbe({stateFile:c.stateFile,workerId:c.workerId,backendPolicyFile:c.backendPolicyFile,
    // Full scope is read ONLY from protected installed config, rechecked per request
    // below. A new handler is NOT made per request: session must persist.
    projects:new Proxy({} as Record<string,string>, {
      get(_target,key){return config().projects[key];},
      ownKeys(){return Object.keys(config().projects);},
      getOwnPropertyDescriptor(){return {enumerable:true,configurable:true};},
    }),
  });
  return (request,response,next)=>{
    if(!request.url.startsWith('/v1/maintenance/backend-shared-write/'))return next();
    try{
      const expected=token();const header=request.headers.authorization??'';const supplied=header.startsWith('Bearer ')?header.slice(7):'';
      if(!expected||Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||!timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))throw new Error('AUTH');
      if(!fs.readFileSync(policyFile).equals(policyBytes))throw new Error('POLICY_CHANGED');
      if(request.method==='GET'&&request.url==='/v1/maintenance/backend-shared-write/status') {
        const identity=assertScopeBackendIdentity(c.backendPolicyFile);
        response.json({version:1,protocol:'scope-shared-write-v1',workerId:c.workerId,backend:identity});return;
      }
      const match=/^\/v1\/maintenance\/backend-shared-write\/(exchange|verify|cleaned|abort)$/.exec(request.url);
      if(request.method!=='POST'||!match)throw new Error('ROUTE');
      response.json(probe.handle(match[1] as 'exchange'|'verify'|'cleaned'|'abort',requireEmptyScopeProbeRequest(request)));
    }catch{response.status(409).json({error:'SCOPE_BACKEND_PROBE_REJECTED'});}
  };
}
