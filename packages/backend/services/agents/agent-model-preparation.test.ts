import {describe,it,expect,vi} from 'vitest';
import {runBoundedModelPreparation, type ModelPreparationRunner} from './agent-model-preparation.js';
const runner: ModelPreparationRunner={harnessId:'pinned',model:'synthetic',capabilities:[],maxInputChars:1000,maxOutputChars:1000,timeoutMs:100,run:async()=>JSON.stringify({question:null,plan:'最初の実行案',hypotheses:['初期仮説']})};
describe('isolated model preparation seam (not production enabled)',()=>{
 it('accepts one question or a plan and separate hypotheses',async()=>{expect((await runBoundedModelPreparation('approved inputs',runner)).question).toBeNull();});
 it('rejects tools and excessive cost boundaries before calling model',async()=>{const run=vi.fn();await expect(runBoundedModelPreparation('input',{...runner,capabilities:['web'],run})).rejects.toThrow('Unsafe');expect(run).not.toHaveBeenCalled();});
 it('aborts timed-out runner and rejects authority-changing output',async()=>{
  let signal:AbortSignal|undefined;
  await expect(runBoundedModelPreparation('input',{...runner,timeoutMs:5,run:async(_,s)=>{signal=s;return new Promise(()=>{});}})).rejects.toThrow('timeout');expect(signal?.aborted).toBe(true);
  await expect(runBoundedModelPreparation('input',{...runner,run:async()=>JSON.stringify({question:null,plan:'x',hypotheses:[],authorityPolicy:{}})})).rejects.toThrow('Invalid');
 });
});
