import {expect,it} from 'vitest';
import {validateExecutorCapability,validateExecutorResult} from './workstation-executor-capability.js';
const valid={exitCode:0,stdout:'synthetic-secret',stderr:'bundle-secret',cleanupComplete:true,processGroupExited:true};
it('withholds all raw output for credential bearing commands',()=>{
 const result=validateExecutorResult(valid,{TOWER_REMOTE_GWS_CONFIG_B64:'encoded'});
 expect(result.stdout).not.toContain('synthetic-secret');expect(result.stderr).toBe('');
});
it.each([{cleanupComplete:'true'},{processGroupExited:1}])('rejects nonboolean proof %j',bad=>{
 expect(()=>validateExecutorResult({...valid,...bad},{})).toThrow('CLEANUP_INCOMPLETE');
});
it.each([{stdout:{}},{exitCode:NaN},{stdout:'x'.repeat(1024*1024+1)}])('rejects invalid output',bad=>{
 expect(()=>validateExecutorResult({...valid,...bad},{})).toThrow('RESULT_INVALID');
});
it.each([null,{mapping:null},{mapping:{home:3}}])('rejects malformed runtime mapping',cap=>{
 expect(()=>validateExecutorCapability(cap as any,'p','/p')).toThrow('MAPPING_INVALID');
});
it('never returns extra result fields',()=>{
 const result=validateExecutorResult({...valid,credentials:'sentinel-private',debug:{secret:'sentinel-private'}},{});
 expect(JSON.stringify(result)).not.toContain('sentinel-private');
 expect(Object.keys(result).sort()).toEqual(['cleanupComplete','exitCode','processGroupExited','stderr','stdout']);
});
it('snapshots bootstrap mapping and rejects malformed adapter configuration',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');const {createSignedWorkstationExecutor}=await import('./workstation-executor-capability.js');
 const key=generateKeyPairSync('ed25519').privateKey;
 const mapping={projectId:'p',projectRoot:'/p',home:'/h',controllerUid:1,launcherUid:2,commandUid:3,commandGid:3};
 const options={mapping,socketPath:'/socket',instanceId:'instance',privateKey:key};
 const cap=createSignedWorkstationExecutor(options);mapping.commandUid=1;options.socketPath='/other';
 expect(cap.mapping.commandUid).toBe(3);expect(Object.isFrozen(cap.mapping)).toBe(true);
 expect(()=>createSignedWorkstationExecutor({...options,socketPath:'relative'})).toThrow('BOOTSTRAP_INVALID');
});
