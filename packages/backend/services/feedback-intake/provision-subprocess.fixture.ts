/** Test-only subprocess bridge. Not a production entrypoint or exported command.
 * Requires a sentinel in a bounded disposable fixture root; never used by CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runProvisionLauncher } from './provision-launcher.js';
import { receiveProvision } from './provision-receiver.js';
import { boundedInput, subprocessRunner } from './provision-runtime.js';
const root=process.argv[3];
async function main(){
  if(process.env.FEEDBACK_SUBPROCESS_FIXTURE!=='1'||!path.basename(root).startsWith('feedback-launcher-fixture-')
    ||fs.readFileSync(path.join(root,'TEST-ONLY'),'utf8')!=='disposable')throw new Error();
  const checks={ancestors:(p:string)=>{if(!p.startsWith(root))throw new Error();},host:(h:string)=>{if(h!=='central.example.com')throw new Error();}};
  if(process.argv[2]==='receiver'){
    const input=await boundedInput(process.stdin);
    try{process.stdout.write(JSON.stringify(await receiveProvision(path.join(root,'receiver.json'),input,{ancestors:checks.ancestors}))+'\n');}
    finally{input.fill(0);}return;
  }
  const runner=async(_executable:string,argv:readonly string[],input:Buffer)=>{
    if(argv.at(-2)!=='--binding'||argv.at(-1)!==path.join(root,'receiver.json'))throw new Error();
    // Real separate process/stdin; only fixture marker is added to the clean env.
    const {spawn}=await import('node:child_process');
    return await new Promise<Buffer>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx',new URL(import.meta.url).pathname,'receiver',root],
        {env:{PATH:'/usr/bin:/bin',FEEDBACK_SUBPROCESS_FIXTURE:'1'},stdio:['pipe','pipe','pipe']});
      const parts:Buffer[]=[];child.stdout.on('data',d=>parts.push(d));child.stderr.on('data',()=>{});
      child.on('error',reject);child.on('close',code=>code===0?resolve(Buffer.concat(parts)):reject(new Error('fixture failed')));
      child.stdin.end(input);
    });
  };
  const result=await runProvisionLauncher(path.join(root,'launcher.json'),process.argv.slice(4),{runner,checks});
  process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(()=>{process.stderr.write('feedback_fixture_refused\n');process.exitCode=1;});
