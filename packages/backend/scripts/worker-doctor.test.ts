import {describe,expect,it} from 'vitest';
import {diagnoseLocalWorkerComponents} from '../services/runtime-box/workbench-worker-doctor-local.js';
describe('worker-doctor local operational profile',()=>{
 it('reports the iwinv tunnel separately with the exact repair command',()=>{const [check]=diagnoseLocalWorkerComponents('iwinv-01',()=>false);expect(check).toEqual({name:'tunnel',ok:false,detail:'tower-iwinv-worker-tunnel.service is inactive',fix:'./start.sh worker-repair iwinv-01 --tunnel'})});
 it('does not assume host components for unknown Worker profiles',()=>expect(diagnoseLocalWorkerComponents('worker-other',()=>false)).toEqual([]));
});
